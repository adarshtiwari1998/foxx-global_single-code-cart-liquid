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

// Function to clean price
function cleanPrice(price) {
    let cleanedPrice = price.replace(/[^0-9.]/g, ''); // Remove invalid characters
    cleanedPrice = parseFloat(cleanedPrice).toFixed(2); // Ensure two decimal places
    console.log(`Cleaned price: ${cleanedPrice}`);
    return cleanedPrice;
}

// Function to fetch Shopify variant by SKU
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

// Function to update a product variant in Shopify
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
                    await new Promise((resolve) => setTimeout(resolve, 2000 * attempt)); // Exponential backoff
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
    const range = 'Missing SKU on Website!A:A'; // Adjust the range where you want to add missing SKUs
    const values = [[sku]]; // Wrap SKU in an array

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

// Main function to update Shopify prices from Google Sheet
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
            // Log missing SKU in the sheet and console
            await appendToMissingSKU(sku);
            continue;
        }

        console.log(`SKU found on store: ${sku}`);
        console.log(`Current Store Prices -> Price: ${variant.price}, Compare At Price: ${variant.compareAtPrice}`);

        await updateShopifyVariant(variant.id, variantPrice, compareAtVariantPrice);

        await new Promise((resolve) => setTimeout(resolve, 1000)); // Avoid hitting rate limits
    }
}

// Endpoint to trigger the price update process
app.get('/update-prices', async (req, res) => {
    const range = 'Sheet1!A:C'; // Adjust the range as per your sheet
    try {
        await updatePricesFromSheet(range);
        res.send('Prices updated successfully');
    } catch (error) {
        console.error('Error while updating prices:', error);
        res.status(500).send('Error updating prices');
    }
});

// Start the server
const PORT = process.env.PORT || 8700;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
