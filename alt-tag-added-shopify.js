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

// Function to append alt text data to Google Sheets
async function appendAltTextData(sku, altText, imageName, status) {
    const range = 'Sheet1!A:D'; // Updated to include Name column
    const values = [[sku, altText, imageName, status]];

    try {
        await sheets.spreadsheets.values.append({
            spreadsheetId: spreadsheetId,
            range: range,
            valueInputOption: 'RAW',
            requestBody: {
                values: values,
            },
        });
        console.log(`Alt text data added for SKU: ${sku}`);
    } catch (error) {
        console.error('Error appending alt text data:', error);
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
async function generateAltText(productTitle, variantInfo = '', imageIndex = 1, isSharedImage = false) {
    let prompt;

    if (isSharedImage) {
        prompt = `Create an SEO-friendly alt text for an e-commerce product image that is shared across multiple variants.
        Product title: "${productTitle}"
        Image number: ${imageIndex}

        Requirements:
        - Use only the product title (no variant-specific details)
        - Make it descriptive and SEO-friendly
        - Keep it under 125 characters
        - Make it natural and readable
        - Focus on the main product features

        Return only the alt text, nothing else.`;
    } else {
        prompt = `Create an SEO-friendly alt text for an e-commerce product image specific to a variant.
        Product title: "${productTitle}"
        ${variantInfo ? `Variant details: "${variantInfo}"` : ''}
        Image number: ${imageIndex}

        Requirements:
        - Include both product name and variant details
        - Make it descriptive and SEO-friendly
        - Keep it under 125 characters
        - Make it natural and readable
        - Focus on variant-specific features

        Return only the alt text, nothing else.`;
    }

    try {
        const response = await fetch(`${geminiTextApiUrl}?key=${geminiApiKey}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                contents: [{
                    parts: [{
                        text: prompt
                    }]
                }]
            }),
        });

        const data = await response.json();
        if (data.candidates && data.candidates[0] && data.candidates[0].content) {
            return data.candidates[0].content.parts[0].text.trim();
        }
        return `${productTitle} ${variantInfo} img ${imageIndex}`.trim();
    } catch (error) {
        console.error('Error generating alt text with Gemini:', error);
        return `${productTitle} ${variantInfo} img ${imageIndex}`.trim();
    }
}

// Function to fetch product details including media and variants
async function fetchProductDetailsBySKU(sku) {
    const query = `
        query {
            productVariants(first: 1, query: "sku:${sku}") {
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
        console.log(`Fetching product details for SKU: ${sku}`);
        const response = await fetch(`https://${shopName}.myshopify.com/admin/api/2024-01/graphql.json`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Shopify-Access-Token': shopifyAccessToken,
            },
            body: JSON.stringify({ query }),
        });

        const { data } = await response.json();
        const edges = data.productVariants.edges;
        if (edges.length > 0) {
            return edges[0].node;
        }
        return null;
    } catch (error) {
        console.error('Error fetching product details:', error);
        return null;
    }
}

// Function to update media name and alt text in Shopify
async function updateMediaNameAndAlt(mediaId, altText, imageName, productId, retries = 3) {
    const mutation = `
        mutation productUpdate($input: ProductInput!) {
            productUpdate(input: $input) {
                product {
                    id
                    media(first: 50) {
                        edges {
                            node {
                                id
                                alt
                            }
                        }
                    }
                }
                userErrors {
                    field
                    message
                }
            }
        }
    `;

    const variables = {
        input: {
            id: productId,
            media: [{
                id: mediaId,
                alt: altText
            }]
        }
    };

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            console.log(`Attempt ${attempt} - Updating media for ID: ${mediaId}`);
            console.log(`New alt text: ${altText}`);
            console.log(`New name: ${imageName}`);

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
                    console.log('Retrying...');
                    await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
                }
                continue;
            }

            if (data.productUpdate.userErrors.length > 0) {
                console.error('Media update errors:', data.productUpdate.userErrors);
                return false;
            }

            console.log(`Successfully updated media ${mediaId}`);
            return true;
        } catch (error) {
            console.error(`Error during attempt ${attempt} updating media ${mediaId}:`, error);
        }
    }
    return false;
}

// Function to append missing SKUs to the Google Sheet
async function appendToMissingSKU(sku) {
    const range = 'Missing SKU on Website!A:A';
    const values = [[sku]];

    try {
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

    for (const row of data) {
        const sku = row[skuIndex];

        if (!sku) {
            console.warn('Skipping row: Missing SKU');
            continue;
        }

        console.log(`\n--- Processing SKU: ${sku} ---`);

        const productDetails = await fetchProductDetailsBySKU(sku);
        if (!productDetails) {
            console.warn(`SKU ${sku} not found in Shopify`);
            await appendToMissingSKU(sku);
            await appendAltTextData(sku, 'N/A', 'N/A', 'SKU not found');
            continue;
        }

        const product = productDetails.product;
        const productTitle = product.title;
        const variantTitle = productDetails.title;
        const mediaEdges = product.media.edges;

        if (mediaEdges.length === 0) {
            console.log(`No media found for SKU: ${sku}`);
            await appendAltTextData(sku, 'N/A', 'N/A', 'No media found');
            continue;
        }

        // Analyze image-variant relationships
        const { mediaToVariants } = analyzeImageVariantRelationships(product);

        let successCount = 0;
        let failCount = 0;
        let altTextsGenerated = [];
        let imageNamesGenerated = [];

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

            // Check if this image is shared across multiple variants
            const variantsUsingThisImage = mediaToVariants.get(media.id) || [];
            const isSharedImage = variantsUsingThisImage.length > 1;

            console.log(`Image shared across ${variantsUsingThisImage.length} variants`);

            // Determine variant info based on sharing logic
            let variantInfo = '';
            if (!isSharedImage && variantTitle !== productTitle) {
                variantInfo = variantTitle;
            }

            // Generate SEO-friendly alt text and name using Gemini
            const generatedAltText = await generateAltText(productTitle, variantInfo, imageIndex, isSharedImage);
            const generatedImageName = generateImageName(productTitle, variantInfo, imageIndex, isSharedImage);

            console.log(`Generated alt text: "${generatedAltText}"`);
            console.log(`Generated image name: "${generatedImageName}"`);

            altTextsGenerated.push(generatedAltText);
            imageNamesGenerated.push(generatedImageName);

            // Update both name and alt text in Shopify
            const updateSuccess = await updateMediaNameAndAlt(media.id, generatedAltText, generatedImageName, product.id);

            if (updateSuccess) {
                successCount++;
                console.log(`✓ Successfully updated image ${imageIndex}`);
            } else {
                failCount++;
                console.log(`✗ Failed to update image ${imageIndex}`);
            }

            // Rate limiting
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }

        // Record the results in Google Sheets
        const status = failCount === 0 ? 'All images updated' : `${successCount} success, ${failCount} failed`;
        const combinedAltTexts = altTextsGenerated.join(' | ');
        const combinedImageNames = imageNamesGenerated.join(' | ');
        await appendAltTextData(sku, combinedAltTexts, combinedImageNames, status);

        console.log(`--- Completed SKU: ${sku} (${successCount}/${successCount + failCount} images updated) ---\n`);

        // Longer delay between products to avoid rate limits
        await new Promise((resolve) => setTimeout(resolve, 2000));
    }
}

// Endpoint to trigger the alt text and name update process
app.get('/update-alt-text', async (req, res) => {
    const range = 'Sheet1!A:A'; // Only need SKU column for processing
    try {
        await updateAltTextFromSheet(range);
        res.send('Alt text updated successfully');
    } catch (error) {
        console.error('Error while updating alt text:', error);
        res.status(500).send('Error updating alt text');
    }
});

// Start the server
const PORT = process.env.PORT || 8700;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(`Available endpoints:`);
    console.log(`- GET /update-alt-text (alt text and image name update)`);
});