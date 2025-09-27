// This file is executed as CommonJS to reliably load pdfjs-dist and its worker
const fs = require('fs');
const path = require('path');
const { createCanvas } = require('canvas');

// Use 'require' and standard pathing which works reliably in CommonJS
const pdfjsLib = require('pdfjs-dist/build/pdf.js');

// Set the worker source using CJS standard path resolution
// This is the definitive fix for the worker loading issue
pdfjsLib.GlobalWorkerOptions.workerSrc = path.join(
    path.dirname(require.resolve('pdfjs-dist/package.json')),
    'build',
    'pdf.worker.js'
);

/**
 * Pure JavaScript PDF rendering function using pdfjs-dist and canvas.
 * @param {string} pdfFilePath - Path to the uploaded PDF.
 * @param {string} outputDir - Directory to save converted images.
 * @returns {Promise<Array<string>>} List of paths to the converted images.
 */
async function convertPdfToImagesPureJS(pdfFilePath, outputDir) {
    const data = new Uint8Array(fs.readFileSync(pdfFilePath));
    const loadingTask = pdfjsLib.getDocument({ data: data });
    const pdf = await loadingTask.promise;
    
    const convertedFilePaths = [];
    const scale = 3.0; // High resolution scale for good AI visibility

    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: scale });
        
        // Create canvas for rendering
        const canvas = createCanvas(viewport.width, viewport.height);
        const context = canvas.getContext('2d');
        
        const renderContext = {
            canvasContext: context,
            viewport: viewport
        };
        
        await page.render(renderContext).promise;
        
        // Save the canvas content as a JPEG image
        const imagePath = path.join(outputDir, `page-${String(i).padStart(4, '0')}.jpg`);
        const out = fs.createWriteStream(imagePath);
        
        // Use quality 0.9 for JPEG compression
        const stream = canvas.createJPEGStream({
            quality: 0.9,
            chromaSubsampling: false // Keep full color detail
        });

        await new Promise((resolve) => {
            stream.pipe(out);
            out.on('finish', resolve);
        });

        convertedFilePaths.push(imagePath);
    }

    return convertedFilePaths;
}

// Export the function for use in the main ESM server file
module.exports = {
    convertPdfToImagesPureJS
};
