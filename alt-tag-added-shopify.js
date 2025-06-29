import express from 'express';
import fetch from 'node-fetch';
import cors from 'cors';
import dotenv from 'dotenv';
import { google } from 'googleapis';
import fs from 'fs';

const app = express();
dotenv.config();
app.use(cors());

// Shopify and Google Sheets Setup
const shopName = 'shopfls';
const shopifyAccessToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
const spreadsheetId = process.env.GOOGLE_SHEET_ID;
const geminiApiKey = process.env.GEMINI_API_KEY;
const geminiTextApiUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

const credentials = JSON.parse(fs.readFileSync('credentials.json'));
const auth = new google.auth.JWT(
    credentials.client_email,
    null,
    credentials.private_key.replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets']
);
const sheets = google.sheets({ version: 'v4', auth });

// Function to read data from Google Sheets
async function readGoogleSheet(range) {
    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: spreadsheetId,
            range,
        });
        return response.data.values || [];
    } catch (error) {
        console.error('Error reading Google Sheet:', error);
        throw error;
    }
}

// Function to check if SKU is already processed
async function isSkuAlreadyProcessed(sku) {
    try {
        const range = 'Sheet1!A:E';
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: spreadsheetId,
            range: range,
        });

        const values = response.data.values || [];

        // Skip header row and check if SKU exists with UPDATED status
        for (let i = 1; i < values.length; i++) {
            const row = values[i];
            if (row[0] === sku && row[3] === 'UPDATED') {
                return true;
            }
        }
        return false;
    } catch (error) {
        console.error('Error checking SKU status:', error);
        return false;
    }
}

// Function to append alt text data to Google Sheets
async function appendAltTextData(sku, altText, imageName, status, remarks) {
    const range = 'Sheet1!A:E';
    const values = [[sku, altText, imageName, status, remarks]];

    try {
        await sheets.spreadsheets.values.append({
            spreadsheetId: spreadsheetId,
            range: range,
            valueInputOption: 'RAW',
            requestBody: {
                values: values,
            },
        });
        console.log(`Alt text data added for SKU: ${sku} - Status: ${status} - Remarks: ${remarks}`);
    } catch (error) {
        console.error('Error appending alt text data:', error);
    }
}

// Function to update existing row for SKU
async function updateSkuStatus(sku, altText, imageName, status, remarks) {
    try {
        const range = 'Sheet1!A:E';
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: spreadsheetId,
            range: range,
        });

        const values = response.data.values || [];

        // Find the row with the SKU
        for (let i = 1; i < values.length; i++) {
            const row = values[i];
            if (row[0] === sku) {
                // Update the specific row
                const updateRange = `Sheet1!A${i + 1}:E${i + 1}`;
                await sheets.spreadsheets.values.update({
                    spreadsheetId: spreadsheetId,
                    range: updateRange,
                    valueInputOption: 'RAW',
                    requestBody: {
                        values: [[sku, altText, imageName, status, remarks]],
                    },
                });
                console.log(`Updated existing row for SKU: ${sku} - Status: ${status} - Remarks: ${remarks}`);
                return;
            }
        }

        // If SKU not found, append new row
        await appendAltTextData(sku, altText, imageName, status, remarks);
    } catch (error) {
        console.error('Error updating SKU status:', error);
        // Fallback to append
        await appendAltTextData(sku, altText, imageName, status, remarks);
    }
}

// Function to analyze which images are shared across variants
function analyzeImageVariantRelationships(product) {
    const mediaToVariants = new Map();
    const variantToMedia = new Map();

    // Map each variant to its media
    product.variants.edges.forEach(variantEdge => {
        const variant = variantEdge.node;
        const variantMediaIds = [];

        // In Shopify, we need to check if variant has specific images assigned
        // For now, we'll assume all variants share the same product media
        product.media.edges.forEach(mediaEdge => {
            const media = mediaEdge.node;
            if (media.image) { // Only process images
                variantMediaIds.push(media.id);

                if (!mediaToVariants.has(media.id)) {
                    mediaToVariants.set(media.id, []);
                }
                mediaToVariants.get(media.id).push({
                    id: variant.id,
                    title: variant.title,
                    sku: variant.sku
                });
            }
        });

        variantToMedia.set(variant.id, variantMediaIds);
    });

    return { mediaToVariants, variantToMedia };
}

// Function to get variant information for an image
function getVariantInfoForImage(mediaToVariants, mediaId) {
    const variants = mediaToVariants.get(mediaId) || [];
    if (variants.length === 0) return '';

    // Extract unique variant titles (excluding default titles that match product name)
    const variantTitles = variants
        .map(v => v.title)
        .filter((title, index, arr) => arr.indexOf(title) === index) // Remove duplicates
        .filter(title => title && title !== 'Default Title'); // Remove empty and default titles

    // If image is shared across many variants (more than 5), use a generic approach
    if (variantTitles.length > 5) {
        // Try to find common patterns or categories
        const hasColors = variantTitles.some(title => 
            /(red|blue|green|yellow|black|white|clear|transparent)/i.test(title)
        );
        const hasSizes = variantTitles.some(title => 
            /(small|medium|large|xs|s|m|l|xl|\d+ml|\d+L|\d+mm|\d+cm)/i.test(title)
        );

        let summary = '';
        if (hasColors && hasSizes) {
            summary = 'Multiple Colors & Sizes';
        } else if (hasColors) {
            summary = 'Multiple Colors';
        } else if (hasSizes) {
            summary = 'Multiple Sizes';
        } else {
            summary = `${variantTitles.length} Variants Available`;
        }

        return summary;
    }

    // For 5 or fewer variants, include them all
    return variantTitles.join(' | ');
}

// Function to generate SEO-friendly image name
function generateImageName(productTitle, variantInfo = '', imageIndex = 1, isSharedImage = false) {
    const cleanTitle = productTitle.toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .replace(/\s+/g, '_')
        .substring(0, 30);

    if (isSharedImage || !variantInfo) {
        return `${cleanTitle}_img_${imageIndex}`;
    } else {
        const cleanVariant = variantInfo.toLowerCase()
            .replace(/[^a-z0-9\s]/g, '')
            .replace(/\s+/g, '_')
            .substring(0, 20);
        return `${cleanTitle}_${cleanVariant}_img_${imageIndex}`;
    }
}

// Function to generate alt text using Gemini AI
async function generateAltText(productTitle, variantInfo = '', imageIndex = 1) {
    // Required components that must always be included
    const imageNumber = ` | img_${imageIndex}`;
    const brandSuffix = ' | Foxx Life Sciences Global | shopfls.com';
    const requiredSuffixLength = imageNumber.length + brandSuffix.length;
    const maxContentLength = 200 - requiredSuffixLength; // Leave room for required suffix

    const prompt = `Transform this product title into a compelling, SEO-optimized alt text for an image:

    Original Product: "${productTitle}"
    ${variantInfo ? `Variant Details: "${variantInfo}"` : ''}

    CRITICAL REQUIREMENTS:
    - Maximum ${maxContentLength} characters for the description (excluding image number and brand suffix)
    - Must be concise but descriptive
    - Keep all brand names: EZBio®, Foxx, VersaCap®, etc.
    - Keep model numbers: 83B, etc.
    - Keep key specifications: 40L, 50L, etc.

    ENHANCE WITH (if space allows):
    - Key adjectives (premium, laboratory-grade, leak-proof)
    - Usage context (laboratory, bioprocessing, research)
    - Essential product benefits

    WRITE STYLE:
    - Concise and informative
    - Professional terminology
    - Essential keywords for SEO
    - Complete phrases, avoid unnecessary words

    Example:
    Instead of long descriptions, create: "Premium EZBio® Silicone Cap System with VersaCap® 83B for 40L/50L Carboys - Laboratory-Grade Leak-Proof Bioprocessing Equipment"

    Return ONLY the enhanced description under ${maxContentLength} characters, nothing else.`;

    try {
        console.log('\n=== GEMINI API REQUEST ===');
        console.log('Product Title:', productTitle);
        console.log('Variant Info:', variantInfo);
        console.log('Image Index:', imageIndex);
        console.log('Prompt being sent to Gemini:');
        console.log('---START PROMPT---');
        console.log(prompt);
        console.log('---END PROMPT---');

        const requestBody = {
            contents: [{
                parts: [{
                    text: prompt
                }]
            }]
        };

        console.log('\nSending request to Gemini API...');

        const response = await fetch(`${geminiTextApiUrl}?key=${geminiApiKey}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(requestBody),
        });

        console.log('Gemini API Response Status:', response.status, response.statusText);

        const data = await response.json();

        console.log('\n=== GEMINI API FULL RESPONSE ===');
        console.log(JSON.stringify(data, null, 2));

        // Check for quota exceeded error - use fallback instead of stopping
        if (data.error && data.error.code === 429) {
            console.log('\n!!! GEMINI API QUOTA EXCEEDED - USING FALLBACK !!!');
            console.log('Error message:', data.error.message);

            // Check if there's retry delay information
            if (data.error.details) {
                const retryInfo = data.error.details.find(detail => detail['@type'] === 'type.googleapis.com/google.rpc.RetryInfo');
                if (retryInfo && retryInfo.retryDelay) {
                    console.log('Suggested retry delay:', retryInfo.retryDelay);
                }
            }

            // Use fallback instead of returning quota exceeded indicator
            console.log('Using fallback alt text generation due to quota limit...');
            const maxContentLength = 200 - imageNumber.length - brandSuffix.length;
            let fallbackContent = productTitle;
            if (variantInfo) {
                fallbackContent = `${productTitle} - ${variantInfo}`;
            }
            if (fallbackContent.length > maxContentLength) {
                fallbackContent = fallbackContent.substring(0, maxContentLength).trim();
                const lastSpaceIndex = fallbackContent.lastIndexOf(' ');
                if (lastSpaceIndex > maxContentLength * 0.8) {
                    fallbackContent = fallbackContent.substring(0, lastSpaceIndex);
                }
            }
            const fallbackAltText = fallbackContent + imageNumber + brandSuffix;
            console.log('\n=== QUOTA EXCEEDED FALLBACK ALT TEXT ===');
            console.log('Fallback alt text:', fallbackAltText);
            return fallbackAltText;
        }

        // Check for other API errors
        if (data.error) {
            console.log('\n!!! GEMINI API ERROR !!!');
            console.log('Error:', data.error);
            throw new Error(`Gemini API Error: ${data.error.message}`);
        }

        if (data.candidates && data.candidates[0] && data.candidates[0].content) {
            let optimizedContent = data.candidates[0].content.parts[0].text.trim();

            console.log('\n=== GEMINI GENERATED CONTENT ===');
            console.log('Raw Gemini Output:', optimizedContent);

            // Remove quotes if Gemini added them
            optimizedContent = optimizedContent.replace(/^["']|["']$/g, '');
            console.log('After removing quotes:', optimizedContent);

            // Remove any ellipsis that Gemini might have added
            optimizedContent = optimizedContent.replace(/\.\.\.$/g, '');
            console.log('After removing ellipsis:', optimizedContent);

            // Ensure the content doesn't exceed the limit
            const maxContentLength = 200 - imageNumber.length - brandSuffix.length;
            if (optimizedContent.length > maxContentLength) {
                console.log(`Content too long (${optimizedContent.length} chars), truncating to ${maxContentLength} chars`);
                optimizedContent = optimizedContent.substring(0, maxContentLength).trim();
                // Remove incomplete word at the end
                const lastSpaceIndex = optimizedContent.lastIndexOf(' ');
                if (lastSpaceIndex > maxContentLength * 0.8) { // Only if we're not cutting too much
                    optimizedContent = optimizedContent.substring(0, lastSpaceIndex);
                }
                console.log('After truncation:', optimizedContent);
            }

            const finalAltText = optimizedContent + imageNumber + brandSuffix;
            console.log('\n=== FINAL ALT TEXT ===');
            console.log('Final alt text:', finalAltText);
            console.log('Character count:', finalAltText.length);

            return finalAltText;
        } else {
            console.log('\n!!! GEMINI RESPONSE MISSING EXPECTED STRUCTURE !!!');
            console.log('Using fallback: original product title');
        }

        // Fallback: use truncated product title with variant info
        const maxContentLength = 200 - imageNumber.length - brandSuffix.length;
        let fallbackContent = productTitle;
        if (variantInfo) {
            fallbackContent = `${productTitle} - ${variantInfo}`;
        }
        if (fallbackContent.length > maxContentLength) {
            fallbackContent = fallbackContent.substring(0, maxContentLength).trim();
            const lastSpaceIndex = fallbackContent.lastIndexOf(' ');
            if (lastSpaceIndex > maxContentLength * 0.8) {
                fallbackContent = fallbackContent.substring(0, lastSpaceIndex);
            }
        }
        const fallbackAltText = fallbackContent + imageNumber + brandSuffix;
        console.log('\n=== FALLBACK ALT TEXT ===');
        console.log('Fallback alt text:', fallbackAltText);
        return fallbackAltText;

    } catch (error) {
        console.error('\n!!! ERROR GENERATING OPTIMIZED ALT TEXT !!!');
        console.error('Error details:', error);

        // Fallback: use truncated product title with variant info
        const maxContentLength = 200 - imageNumber.length - brandSuffix.length;
        let fallbackContent = productTitle;
        if (variantInfo) {
            fallbackContent = `${productTitle} - ${variantInfo}`;
        }
        if (fallbackContent.length > maxContentLength) {
            fallbackContent = fallbackContent.substring(0, maxContentLength).trim();
            const lastSpaceIndex = fallbackContent.lastIndexOf(' ');
            if (lastSpaceIndex > maxContentLength * 0.8) {
                fallbackContent = fallbackContent.substring(0, lastSpaceIndex);
            }
        }
        const fallbackAltText = fallbackContent + imageNumber + brandSuffix;
        console.log('\n=== ERROR FALLBACK ALT TEXT ===');
        console.log('Error fallback alt text:', fallbackAltText);
        return fallbackAltText;
    }
}

// Function to fetch product details including media and variants
async function fetchProductDetailsBySKU(sku) {
    // Try multiple SKU variations to handle Google Sheets auto-formatting
    const skuVariations = [
        sku, // Original SKU as provided
        // Remove leading zeros from the last segment after the last dash
        sku.replace(/-0+(\d+)$/, '-$1'),
        // Remove leading zeros from all segments after dashes
        sku.replace(/-0+(\d+)/g, '-$1')
    ];

    // Remove duplicates and keep unique variations
    const uniqueSkus = [...new Set(skuVariations)];
    
    console.log(`Trying SKU variations: ${uniqueSkus.join(', ')}`);

    for (const skuToTry of uniqueSkus) {
        const query = `
            query {
                productVariants(first: 1, query: "sku:${skuToTry}") {
                    edges {
                        node {
                            id
                            sku
                            title
                            product {
                                id
                                title
                                media(first: 50) {
                                    edges {
                                        node {
                                            id
                                            alt
                                            ... on MediaImage {
                                                image {
                                                    url
                                                }
                                            }
                                            ... on Video {
                                                sources {
                                                    url
                                                }
                                            }
                                        }
                                    }
                                }
                                variants(first: 50) {
                                    edges {
                                        node {
                                            id
                                            title
                                            sku
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        `;

        try {
            console.log(`Fetching product details for SKU variation: ${skuToTry}`);

            // Check if access token is available
            if (!shopifyAccessToken) {
                console.error('Shopify access token is missing');
                return null;
            }

            const response = await fetch(`https://${shopName}.myshopify.com/admin/api/2024-01/graphql.json`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Shopify-Access-Token': shopifyAccessToken,
                },
                body: JSON.stringify({ query }),
            });

            // Check if response is ok
            if (!response.ok) {
                console.error(`Shopify API response not ok: ${response.status} ${response.statusText}`);
                continue; // Try next variation
            }

            const responseData = await response.json();

            // Check if response has errors
            if (responseData.errors) {
                console.error('Shopify GraphQL errors:', responseData.errors);
                continue; // Try next variation
            }

            // Check if data exists and has the expected structure
            if (!responseData.data || !responseData.data.productVariants) {
                console.error('Invalid response structure from Shopify API:', responseData);
                continue; // Try next variation
            }

            const edges = responseData.data.productVariants.edges;
            if (edges.length > 0) {
                console.log(`✓ Found product with SKU variation: ${skuToTry} (original: ${sku})`);
                return edges[0].node;
            }
        } catch (error) {
            console.error(`Error fetching product details for SKU ${skuToTry}:`, error);
            continue; // Try next variation
        }
    }

    console.log(`✗ No product found for any SKU variation of: ${sku}`);
    return null;
}

// Function to update only alt text in Shopify (skip name updates)
async function updateMediaAltText(mediaId, altText, retries = 3) {
    const mutation = `
        mutation fileUpdate($files: [FileUpdateInput!]!) {
            fileUpdate(files: $files) {
                files {
                    id
                    alt
                }
                userErrors {
                    field
                    message
                }
            }
        }
    `;

    const variables = {
        files: [{
            id: mediaId,
            alt: altText
        }]
    };

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            console.log(`Attempt ${attempt} - Updating alt text for media ID: ${mediaId}`);
            console.log(`New alt text: ${altText}`);

            const response = await fetch(`https://${shopName}.myshopify.com/admin/api/2024-01/graphql.json`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Shopify-Access-Token': shopifyAccessToken,
                },
                body: JSON.stringify({ query: mutation, variables }),
            });

            const { data, errors } = await response.json();

            if (errors) {
                console.error('GraphQL errors:', errors);
                if (attempt < retries) {
                    console.log(`Retrying in ${3000 * attempt}ms...`);
                    await new Promise((resolve) => setTimeout(resolve, 3000 * attempt));
                }
                continue;
            }

            if (data.fileUpdate.userErrors.length > 0) {
                console.error('Media update errors:', data.fileUpdate.userErrors);
                return false;
            }

            console.log(`Successfully updated alt text for media ${mediaId}`);
            return true;
        } catch (error) {
            console.error(`Error during attempt ${attempt} updating media ${mediaId}:`, error);
        }
    }
    return false;
}

// Function to extract image name from URL
function extractImageNameFromUrl(imageUrl) {
    try {
        const url = new URL(imageUrl);
        const pathname = url.pathname;
        const fileName = pathname.split('/').pop();
        // Remove query parameters and file extension for cleaner name
        const nameWithoutParams = fileName.split('?')[0];
        const nameWithoutExt = nameWithoutParams.split('.')[0];
        return nameWithoutExt || 'unnamed_image';
    } catch (error) {
        console.error('Error extracting image name from URL:', error);
        return 'unnamed_image';
    }
}

// Function to append missing SKUs to the Google Sheet
async function appendToMissingSKU(sku) {
    try {
        // First, try to read from the Missing SKU sheet to see if it exists
        const range = 'Missing SKU on Website!A:A';

        try {
            // Try to get the sheet first
            await sheets.spreadsheets.values.get({
                spreadsheetId: spreadsheetId,
                range: range,
            });
        } catch (sheetError) {
            // If sheet doesn't exist, log and use main sheet instead
            console.log(`Missing SKU sheet doesn't exist, logging to main sheet instead for SKU: ${sku}`);
            return;
        }

        // If sheet exists, append the SKU
        const values = [[sku]];
        await sheets.spreadsheets.values.append({
            spreadsheetId: spreadsheetId,
            range: range,
            valueInputOption: 'RAW',
            requestBody: {
                values: values,
            },
        });
        console.log(`Missing SKU added: ${sku}`);
    } catch (error) {
        console.error('Error appending missing SKU:', error);
    }
}

// Main function to update alt text for product images
async function updateAltTextFromSheet(range) {
    const rows = await readGoogleSheet(range);

    if (!rows || rows.length === 0) {
        console.error('No data found in Google Sheet');
        return;
    }

    const [headers, ...data] = rows;

    if (!headers || headers.length === 0) {
        console.error('No headers found in Google Sheet');
        return;
    }

    const skuIndex = headers.indexOf('sku');

    if (skuIndex === -1) {
        console.error('SKU column not found in Google Sheet. Available columns:', headers);
        return;
    }

    // Track processed products to avoid duplicate processing
    const processedProducts = new Set();

    // Check the status sheet to see which SKUs already have alt text
    const statusRows = await readGoogleSheet('Sheet1!A:E');
    const processedSKUs = new Set();

    if (statusRows && statusRows.length > 1) {
        // Skip header row
        for (let i = 1; i < statusRows.length; i++) {
            const statusRow = statusRows[i];
            const processedSku = statusRow[0]; // SKU column
            const altText = statusRow[1]; // Alt text column
            const status = statusRow[3]; // Status column

            // If SKU has alt text filled and status is UPDATED, mark as already processed
            if (processedSku && altText && altText !== 'Processing...' && altText !== 'N/A' && status === 'UPDATED') {
                processedSKUs.add(processedSku);
            }
        }
    }

    console.log(`Found ${processedSKUs.size} already processed SKUs, will skip these.`);

    for (const row of data) {
        const sku = row[skuIndex];

        if (!sku) {
            console.warn('Skipping row: Missing SKU');
            continue;
        }

        // Check if this SKU is already processed
        if (processedSKUs.has(sku)) {
            console.log(`\n--- SKIPPING SKU: ${sku} (Already has alt text in sheet) ---`);
            continue;
        }

        console.log(`\n--- Processing SKU: ${sku} (Generating new alt text) ---`);

        // Update sheet with "Processing" status
        await updateSkuStatus(sku, 'Processing...', 'Processing...', 'Processing', 'Processing...');

        const productDetails = await fetchProductDetailsBySKU(sku);
        if (!productDetails) {
            console.warn(`SKU ${sku} not found in Shopify`);
            await appendToMissingSKU(sku);
            await updateSkuStatus(sku, 'N/A', 'N/A', 'FAILED', 'SKU not found in Shopify');
            continue;
        }

        const product = productDetails.product;
        const productTitle = product.title;
        const variantTitle = productDetails.title;
        const mediaEdges = product.media.edges;

        if (mediaEdges.length === 0) {
            console.log(`No media found for SKU: ${sku}`);
            await updateSkuStatus(sku, 'N/A', 'N/A', 'FAILED', 'No media found for this product');
            continue;
        }

        // Check if this product has already been processed
        if (processedProducts.has(product.id)) {
            console.log(`\n--- SKIPPING SKU: ${sku} (Product ${product.id} already processed) ---`);
            await updateSkuStatus(sku, 'Already processed with another SKU', 'Already processed with another SKU', 'UPDATED', 'Product images already updated with another variant SKU');
            continue;
        }

        // Mark this product as processed
        processedProducts.add(product.id);

        // Analyze image-variant relationships
        const { mediaToVariants } = analyzeImageVariantRelationships(product);

        let successCount = 0;
        let failCount = 0;
        let altTextsGenerated = [];
        let existingImageNames = [];

        for (let i = 0; i < mediaEdges.length; i++) {
            const media = mediaEdges[i].node;
            const imageIndex = i + 1;

            // Check if it's an image (skip videos)
            if (!media.image) {
                console.log(`Skipping non-image media for SKU: ${sku}`);
                continue;
            }

            console.log(`Processing image ${imageIndex} for SKU: ${sku}`);
            console.log(`Current alt text: "${media.alt || 'Empty'}"`);

            // Get variant information for this specific image
            const variantInfo = getVariantInfoForImage(mediaToVariants, media.id);
            const variantsUsingThisImage = mediaToVariants.get(media.id) || [];

            console.log(`Image assigned to ${variantsUsingThisImage.length} variants`);
            if (variantInfo) {
                console.log(`Variant info for this image: "${variantInfo}"`);
            }

            // Generate SEO-friendly image name using the generateImageName function
            const isSharedImage = variantsUsingThisImage.length > 3; // Consider shared if used by more than 3 variants
            const generatedImageName = generateImageName(productTitle, variantInfo, imageIndex, isSharedImage);
            console.log(`Generated image name: "${generatedImageName}"`);
            existingImageNames.push(generatedImageName);

            // Generate SEO-friendly alt text using Gemini with variant info
            const generatedAltText = await generateAltText(productTitle, variantInfo, imageIndex);

            console.log(`Generated alt text: "${generatedAltText}"`);

            altTextsGenerated.push(generatedAltText);

            // Update only alt text in Shopify (skip name updates)
            const updateSuccess = await updateMediaAltText(media.id, generatedAltText);

            if (updateSuccess) {
                successCount++;
                console.log(`✓ Successfully updated alt text for image ${imageIndex}`);
            } else {
                failCount++;
                console.log(`✗ Failed to update alt text for image ${imageIndex}`);
            }

            // Rate limiting - increased delay to avoid API limits
            await new Promise((resolve) => setTimeout(resolve, 2000));
        }

        // Record the results in Google Sheets
        const status = failCount === 0 ? 'UPDATED' : 'FAILED';
        const remarks = failCount === 0 ? `All ${successCount} alt texts updated` : `${successCount} success, ${failCount} failed`;
        const combinedAltTexts = altTextsGenerated.join(' | ');
        const combinedImageNames = existingImageNames.join(' | ');
        await updateSkuStatus(sku, combinedAltTexts, combinedImageNames, status, remarks);

        console.log(`--- Completed SKU: ${sku} (${successCount}/${successCount + failCount} images updated) ---\n`);

        // Longer delay between products to avoid rate limits
        await new Promise((resolve) => setTimeout(resolve, 2000));
    }
}

// Endpoint to trigger the alt text update process (names preserved, resumes from where it left off)
app.get('/update-alt-text', async (req, res) => {
    const range = 'Sheet1!A:A'; // Only need SKU column for processing
    try {
        await updateAltTextFromSheet(range);
        res.send('Alt text updated successfully with brand suffix - resumed from last processed SKU');
    } catch (error) {
        console.error('Error while updating alt text:', error);
        res.status(500).send('Error updating alt text');
    }
});

// Validate required environment variables
function validateEnvironmentVariables() {
    const required = ['SHOPIFY_ADMIN_ACCESS_TOKEN', 'GOOGLE_SHEET_ID', 'GEMINI_API_KEY'];
    const missing = required.filter(key => !process.env[key]);

    if (missing.length > 0) {
        console.error('Missing required environment variables:', missing);
        console.error('Please set these in your .env file or environment');
        return false;
    }

    console.log('✓ All required environment variables are set');
    return true;
}

// Start the server
const PORT = process.env.PORT || 8700;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(`Available endpoints:`);
    console.log(`- GET /update-alt-text (alt text update with brand suffix, preserves image names, resumes from last position)`);

    // Validate environment variables at startup
    validateEnvironmentVariables();
});