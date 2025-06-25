
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
const spreadsheetId = '1HTtIBjNUa98892nAejYV7NJBVPEu7KtlyzKSlQdeln4';
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
async function appendAltTextData(sku, altText, status) {
    const range = 'Alt Text Tracking!A:C'; // New sheet for tracking alt text
    const values = [[sku, altText, status]];

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

// Function to generate alt text using Gemini AI
async function generateAltText(productTitle, variantInfo = '', imageIndex = 1) {
    const prompt = `Create an SEO-friendly alt text for an e-commerce product image. 
    Product title: "${productTitle}"
    ${variantInfo ? `Variant details: "${variantInfo}"` : ''}
    Image number: ${imageIndex}
    
    Requirements:
    - Make it descriptive and SEO-friendly
    - Include the product name
    - If variant info is provided, incorporate it naturally
    - Keep it under 125 characters
    - Make it natural and readable
    - Focus on what's visible in the image
    
    Return only the alt text, nothing else.`;

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

// Function to update media alt text in Shopify
async function updateMediaAltText(mediaId, altText, retries = 3) {
    const mutation = `
        mutation mediaUpdate($media: [UpdateMediaInput!]!) {
            mediaUpdate(media: $media) {
                media {
                    id
                    alt
                }
                mediaUserErrors {
                    field
                    message
                }
            }
        }
    `;

    const variables = {
        media: [{
            id: mediaId,
            alt: altText
        }]
    };

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            console.log(`Attempt ${attempt} - Updating media alt text for ID: ${mediaId}`);
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
                    console.log('Retrying...');
                    await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
                }
                continue;
            }

            if (data.mediaUpdate.mediaUserErrors.length > 0) {
                console.error('Media update errors:', data.mediaUpdate.mediaUserErrors);
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

// Function to clean price
function cleanPrice(price) {
    let cleanedPrice = price.replace(/[^0-9.]/g, '');
    cleanedPrice = parseFloat(cleanedPrice).toFixed(2);
    console.log(`Cleaned price: ${cleanedPrice}`);
    return cleanedPrice;
}

// Function to fetch Shopify variant by SKU (original price update function)
async function fetchVariantBySKU(sku) {
    const query = `
        query {
            productVariants(first: 1, query: "sku:${sku}") {
                edges {
                    node {
                        id
                        sku
                        price
                        compareAtPrice
                    }
                }
            }
        }
    `;

    try {
        console.log(`Fetching variant for SKU: ${sku}`);
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
    } catch (error) {
        console.error('Error fetching variant by SKU:', error);
        return null;
    }
}

// Function to update a product variant in Shopify (original price update function)
async function updateShopifyVariant(variantId, variantPrice, compareAtVariantPrice, retries = 3) {
    const mutation = `
        mutation productVariantUpdate($input: ProductVariantInput!) {
            productVariantUpdate(input: $input) {
                productVariant {
                    id
                    price
                    compareAtPrice
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
            id: variantId,
            price: variantPrice.toString(),
            compareAtPrice: compareAtVariantPrice ? compareAtVariantPrice.toString() : null
        }
    };

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            console.log(`Attempt ${attempt} - Updating variant with ID: ${variantId}`);
            console.log(`Payload: ${JSON.stringify(variables)}`);

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

            const productVariant = data.productVariantUpdate.productVariant;
            console.log(`Successfully updated variant ${variantId}. New Price: ${productVariant.price}, Compare At Price: ${productVariant.compareAtPrice}`);

            return;
        } catch (error) {
            console.error(`Error during attempt ${attempt} updating variant ${variantId}:`, error);
        }
    }
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
    const [headers, ...data] = rows;
    const skuIndex = headers.indexOf('skus');

    if (skuIndex === -1) {
        console.error('SKU column not found in Google Sheet');
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
            await appendAltTextData(sku, 'N/A', 'SKU not found');
            continue;
        }

        const product = productDetails.product;
        const productTitle = product.title;
        const variantTitle = productDetails.title;
        const mediaEdges = product.media.edges;

        if (mediaEdges.length === 0) {
            console.log(`No media found for SKU: ${sku}`);
            await appendAltTextData(sku, 'N/A', 'No media found');
            continue;
        }

        let successCount = 0;
        let failCount = 0;
        let altTextsGenerated = [];

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

            // Generate SEO-friendly alt text using Gemini
            const variantInfo = variantTitle !== productTitle ? variantTitle : '';
            const generatedAltText = await generateAltText(productTitle, variantInfo, imageIndex);
            
            console.log(`Generated alt text: "${generatedAltText}"`);
            altTextsGenerated.push(generatedAltText);

            // Update the alt text in Shopify
            const updateSuccess = await updateMediaAltText(media.id, generatedAltText);
            
            if (updateSuccess) {
                successCount++;
                console.log(`✓ Successfully updated alt text for image ${imageIndex}`);
            } else {
                failCount++;
                console.log(`✗ Failed to update alt text for image ${imageIndex}`);
            }

            // Rate limiting
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }

        // Record the results in Google Sheets
        const status = failCount === 0 ? 'All images updated' : `${successCount} success, ${failCount} failed`;
        const combinedAltTexts = altTextsGenerated.join(' | ');
        await appendAltTextData(sku, combinedAltTexts, status);

        console.log(`--- Completed SKU: ${sku} (${successCount}/${successCount + failCount} images updated) ---\n`);

        // Longer delay between products to avoid rate limits
        await new Promise((resolve) => setTimeout(resolve, 2000));
    }
}

// Main function to update Shopify prices from Google Sheet (original function)
async function updatePricesFromSheet(range) {
    const rows = await readGoogleSheet(range);
    const [headers, ...data] = rows;
    const skuIndex = headers.indexOf('skus');
    const variantPriceIndex = headers.indexOf('Variant Price');
    const compareAtVariantPriceIndex = headers.indexOf('Variant Compare At Price');

    if (skuIndex === -1 || variantPriceIndex === -1 || compareAtVariantPriceIndex === -1) {
        console.error('Required columns not found in Google Sheet');
        return;
    }

    for (const row of data) {
        const [
            sku,
            variantPrice = '0',
            compareAtVariantPrice = '0'
        ] = [
            row[skuIndex],
            cleanPrice(row[variantPriceIndex]),
            cleanPrice(row[compareAtVariantPriceIndex]),
        ];

        if (!sku || !variantPrice || !compareAtVariantPrice) {
            console.warn(`Skipping row: Missing SKU or price fields`);
            continue;
        }

        console.log(`Processing SKU: ${sku}, Variant Price: ${variantPrice}, Compare At Variant Price: ${compareAtVariantPrice}`);

        const variant = await fetchVariantBySKU(sku);
        if (!variant) {
            console.warn(`SKU ${sku} not found in Shopify`);
            await appendToMissingSKU(sku);
            continue;
        }

        console.log(`SKU found on store: ${sku}`);
        console.log(`Current Store Prices -> Price: ${variant.price}, Compare At Price: ${variant.compareAtPrice}`);

        await updateShopifyVariant(variant.id, variantPrice, compareAtVariantPrice);

        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
}

// Endpoint to trigger the price update process (original)
app.get('/update-prices', async (req, res) => {
    const range = 'Sheet1!A:C';
    try {
        await updatePricesFromSheet(range);
        res.send('Prices updated successfully');
    } catch (error) {
        console.error('Error while updating prices:', error);
        res.status(500).send('Error updating prices');
    }
});

// New endpoint to trigger the alt text update process
app.get('/update-alt-text', async (req, res) => {
    const range = 'Sheet1!A:A'; // Only need SKU column for alt text update
    try {
        await updateAltTextFromSheet(range);
        res.send('Alt text updated successfully');
    } catch (error) {
        console.error('Error while updating alt text:', error);
        res.status(500).send('Error updating alt text');
    }
});

// Combined endpoint to update both prices and alt text
app.get('/update-all', async (req, res) => {
    try {
        console.log('Starting price updates...');
        await updatePricesFromSheet('Sheet1!A:C');
        
        console.log('Starting alt text updates...');
        await updateAltTextFromSheet('Sheet1!A:A');
        
        res.send('Both prices and alt text updated successfully');
    } catch (error) {
        console.error('Error while updating:', error);
        res.status(500).send('Error during update process');
    }
});

// Start the server
const PORT = process.env.PORT || 8700;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(`Available endpoints:`);
    console.log(`- GET /update-prices (original price update)`);
    console.log(`- GET /update-alt-text (new alt text update)`);
    console.log(`- GET /update-all (both price and alt text update)`);
});
