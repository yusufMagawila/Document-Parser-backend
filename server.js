import express from "express";
import multer from "multer";
import { GoogleGenAI } from "@google/genai";
import XLSX from "xlsx";
import dotenv from "dotenv";
import cors from "cors";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// CRITICAL: Set your model to the multimodal version
const MODEL_NAME = "gemini-2.5-flash"; 

// --- CORS Configuration ---
const allowedOrigins = [
    'http://localhost:5173', 
    'https://document-parser-one.vercel.app',
];
const corsOptions = {
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
    optionsSuccessStatus: 204
};
app.use(cors(corsOptions));

// Enable JSON body parsing (though only needed for form data now)
app.use(express.json());

// --- MULTER SETUP ---
// Use memory storage for the /upload endpoint (for all image data, including converted PDF pages).
const uploadToMemory = multer({ storage: multer.memoryStorage() });


// Gemini AI setup
if (!process.env.GEMINI_API_KEY) {
    console.error("FATAL ERROR: GEMINI_API_KEY environment variable is not set.");
    process.exit(1);
}
const genAI = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
});

/**
 * Core analysis function.
 * @param {object} file - Contains {buffer, mimetype} (from multer).
 * @param {number} absolutePageNumber - The 1-based index of the page in the overall document.
 * @returns {Array<object>} Extracted member data.
 */
async function analyzeSingleImage(file, absolutePageNumber) {
    const prompt = `
        You are an expert data extraction agent. Analyze the provided CCM ledger image (Page ${absolutePageNumber}).
        **GOAL:** Extract the members on this single page into a perfectly clean JSON array of objects.
        **Required JSON Structure (Array of Objects):**
        [
          {
            "NA": "The sequential row number (e.g., 1, 2, 1059). Must be a clean integer.",
            "Jina la Mwanachama": "The full, complete name of the member/cadre.",
            "Kadi ya CCM/UWT": "The registration number from the CCM/UWT Card column. Use alphanumeric characters.",
            "Kadi ya Mpiga Kura": "The Voter's Card Number. Use alphanumeric characters.",
            "Namba ya Simu": "The complete phone number. If the number is clearly less than 8 digits after cleaning, use the exact string 'FLAG_SHORT_NUMBER'. Otherwise, provide the cleaned number.",
            "Saini / Notes": "Any remaining text, initials, or marks. If empty, use ''."
          },
        ]
        **Instructions:**
        1. Output ONLY the raw JSON array.
        2. Ensure data types match the column descriptions.
    `;

    try {
        const parts = [
            { inlineData: { data: file.buffer.toString("base64"), mimeType: file.mimetype } },
            { text: prompt }
        ];

        const geminiResponse = await genAI.models.generateContent({
            model: MODEL_NAME, 
            contents: parts,
            config: { temperature: 0.1 }
        });

        let cleanedText = geminiResponse.text.trim();
        cleanedText = cleanedText.replace(/^```json\s*/i, '').replace(/\s*```$/, '');
        
        const structuredData = JSON.parse(cleanedText);
        
        if (!Array.isArray(structuredData)) {
            throw new Error("AI output was not a JSON array.");
        }
        
        return structuredData.map(row => ({
            ...row,
            "Source Batch Page": absolutePageNumber
        }));

    } catch (e) {
        console.error(`Error processing page ${absolutePageNumber}:`, e.message);
        return [{ 
            "NA": -1, 
            "Jina la Mwanachama": `ERROR on Page ${absolutePageNumber}`, 
            "Kadi ya CCM/UWT": "N/A", 
            "Kadi ya Mpiga Kura": "N/A", 
            "Namba ya Simu": "N/A", 
            "Saini / Notes": e.message,
            "Source Batch Page": absolutePageNumber
        }];
    }
}

// Helper to generate and send the final Excel file
function generateAndSendExcel(res, finalData, customDownloadName) {
    const finalFilename = `${customDownloadName.replace(/[^a-z0-9_]/gi, '_').substring(0, 50)}.xlsx`;
    
    // 1. Post-Processing & Validation 
    const dataWithValidation = finalData.map(row => {
        let reviewNeeded = 'NO';
        
        // Validation Logic
        if (row["Namba ya Simu"] === 'FLAG_SHORT_NUMBER') {
            row["Namba ya Simu"] = 'MISSING (Review)'; 
            reviewNeeded = 'YES - Short Phone';
        } else if (String(row["Namba ya Simu"] || '').replace(/[^0-9]/g, '').length < 8) {
            reviewNeeded = (reviewNeeded === 'NO' ? 'YES - Phone too short' : `${reviewNeeded}, Phone too short`);
        }
        
        const ccmCard = String(row["Kadi ya CCM/UWT"] || '').replace(/[^a-z0-9]/gi, '');
        if (ccmCard.length < 5 && reviewNeeded.indexOf('Card') === -1) {
            reviewNeeded = (reviewNeeded === 'NO' ? 'YES - Short CCM Card' : `${reviewNeeded}, Short CCM Card`);
        }

        return {
            ...row,
            "Review Required": reviewNeeded
        };
    });

    // 2. Convert JSON → Excel and Send 
    const worksheet = XLSX.utils.json_to_sheet(dataWithValidation);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "ParsedData");
    const excelBuffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

    // Send file back to client
    res.setHeader("Content-Disposition", `attachment; filename="${finalFilename}"`);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.send(excelBuffer);
}

// --- CORE ROUTE: DIRECT IMAGE/BATCH ANALYSIS (Uses in-memory files) ---
// This now handles ALL image batches (direct upload or converted PDF pages)
app.post("/upload", uploadToMemory.array("files"), async (req, res) => {
    try {
        const files = req.files;
        const customDownloadName = req.body.downloadName || 'Batch_Analysis';
        
        if (!files || files.length === 0) {
            return res.status(400).json({ error: 'No image files were uploaded in the batch.' });
        }

        console.log(`Starting concurrent analysis of ${files.length} images...`);

        // 1. CONCURRENCY: Start all AI analysis jobs simultaneously
        const analysisPromises = files.map((file, index) => {
            // The client names the files with the absolute page number in the filename, 
            // but we use the index here as the client is responsible for the overall batching.
            return analyzeSingleImage(file, index + 1); 
        });
        
        // Wait for all promises to resolve
        const resultsByPage = await Promise.all(analysisPromises);
        
        // 2. Aggregate Results: Flatten the array of arrays into one long list of members
        const allMembersData = resultsByPage.flat();
        
        console.log(`Successfully extracted ${allMembersData.length} total members. Generating Excel.`);

        // 3. Convert JSON → Excel and Send 
        generateAndSendExcel(res, allMembersData, customDownloadName);

    } catch (err) {
        console.error("❌ Critical Error processing batch:", err);
        res.status(500).json({ error: err.message || "Failed to process the batch. Check server logs." });
    }
});


app.listen(PORT, () => {
    console.log(`✅ Server running on http://localhost:${PORT}`);
    console.log(`🚀 AI Model: ${MODEL_NAME}`);
});