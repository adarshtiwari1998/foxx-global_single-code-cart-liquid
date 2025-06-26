
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

// Function to update Google Sheet with redirect URL
async function updateRedirectTo(rowIndex, redirectToUrl) {
    try {
        const range = `Sheet1!B${rowIndex + 1}`;
        await sheets.spreadsheets.values.update({
            spreadsheetId: spreadsheetId,
            range: range,
            valueInputOption: 'RAW',
            requestBody: {
                values: [[redirectToUrl]],
            },
        });
        console.log(`Updated row ${rowIndex + 1} with redirect: ${redirectToUrl}`);
    } catch (error) {
        console.error('Error updating Google Sheet:', error);
    }
}

// Function to fetch all products from Shopify
async function fetchAllProducts() {
    const products = [];
    let cursor = null;
    let hasNextPage = true;

    while (hasNextPage) {
        const query = `
            query($cursor: String) {
                products(first: 250, after: $cursor) {
                    edges {
                        node {
                            id
                            title
                            handle
                            productType
                            tags
                        }
                        cursor
                    }
                    pageInfo {
                        hasNextPage
                        endCursor
                    }
                }
            }
        `;

        try {
            const response = await fetch(`https://${shopName}.myshopify.com/admin/api/2024-01/graphql.json`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Shopify-Access-Token': shopifyAccessToken,
                },
                body: JSON.stringify({ 
                    query, 
                    variables: { cursor }
                }),
            });

            const data = await response.json();
            
            if (data.errors) {
                console.error('GraphQL errors:', data.errors);
                break;
            }

            const edges = data.data.products.edges;
            products.push(...edges.map(edge => edge.node));
            
            hasNextPage = data.data.products.pageInfo.hasNextPage;
            cursor = data.data.products.pageInfo.endCursor;
            
            console.log(`Fetched ${products.length} products so far...`);
            
            // Rate limiting
            await new Promise(resolve => setTimeout(resolve, 500));
        } catch (error) {
            console.error('Error fetching products:', error);
            break;
        }
    }

    console.log(`Total products fetched: ${products.length}`);
    return products;
}

// Function to fetch all collections from Shopify
async function fetchAllCollections() {
    const collections = [];
    let cursor = null;
    let hasNextPage = true;

    while (hasNextPage) {
        const query = `
            query($cursor: String) {
                collections(first: 250, after: $cursor) {
                    edges {
                        node {
                            id
                            title
                            handle
                            description
                        }
                        cursor
                    }
                    pageInfo {
                        hasNextPage
                        endCursor
                    }
                }
            }
        `;

        try {
            const response = await fetch(`https://${shopName}.myshopify.com/admin/api/2024-01/graphql.json`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Shopify-Access-Token': shopifyAccessToken,
                },
                body: JSON.stringify({ 
                    query, 
                    variables: { cursor }
                }),
            });

            const data = await response.json();
            
            if (data.errors) {
                console.error('GraphQL errors:', data.errors);
                break;
            }

            const edges = data.data.collections.edges;
            collections.push(...edges.map(edge => edge.node));
            
            hasNextPage = data.data.collections.pageInfo.hasNextPage;
            cursor = data.data.collections.pageInfo.endCursor;
            
            console.log(`Fetched ${collections.length} collections so far...`);
            
            // Rate limiting
            await new Promise(resolve => setTimeout(resolve, 500));
        } catch (error) {
            console.error('Error fetching collections:', error);
            break;
        }
    }

    console.log(`Total collections fetched: ${collections.length}`);
    return collections;
}

// Function to extract keywords from URL
function extractKeywordsFromUrl(url) {
    try {
        const urlObj = new URL(url);
        const pathname = urlObj.pathname;
        
        // Remove common URL parts and extract meaningful keywords
        const cleanPath = pathname
            .replace(/^\/+(products|collections)\/+/, '') // Remove /products/ or /collections/
            .replace(/\/+$/, '') // Remove trailing slashes
            .replace(/[^a-zA-Z0-9\-\s]/g, ' ') // Replace special chars with spaces
            .replace(/\-/g, ' ') // Replace hyphens with spaces
            .toLowerCase()
            .trim();
        
        // Split into individual keywords and filter out common words
        const stopWords = ['the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'up', 'about', 'into', 'over', 'after'];
        const keywords = cleanPath
            .split(/\s+/)
            .filter(word => word.length > 2 && !stopWords.includes(word));
        
        return keywords;
    } catch (error) {
        console.error('Error extracting keywords from URL:', error);
        return [];
    }
}

// Function to calculate similarity score between keywords and product/collection
function calculateSimilarityScore(urlKeywords, item) {
    const itemText = `${item.title} ${item.handle} ${item.productType || ''} ${(item.tags || []).join(' ')} ${item.description || ''}`.toLowerCase();
    
    let score = 0;
    let totalKeywords = urlKeywords.length;
    
    for (const keyword of urlKeywords) {
        if (itemText.includes(keyword)) {
            // Exact match in title gets highest score
            if (item.title.toLowerCase().includes(keyword)) {
                score += 3;
            }
            // Match in handle gets high score
            else if (item.handle.toLowerCase().includes(keyword)) {
                score += 2;
            }
            // Match anywhere else gets lower score
            else {
                score += 1;
            }
        }
    }
    
    return totalKeywords > 0 ? score / totalKeywords : 0;
}

// Function to determine the original URL type (product or collection)
function getOriginalUrlType(url) {
    try {
        const urlObj = new URL(url);
        const pathname = urlObj.pathname;
        
        // Check if URL contains /collections/
        if (pathname.includes('/collections/')) {
            return 'collection';
        }
        // Check if URL contains /products/
        if (pathname.includes('/products/')) {
            return 'product';
        }
        
        return null;
    } catch (error) {
        console.error('Error determining URL type:', error);
        return null;
    }
}

// Function to find best matching product or collection with type preference
function findBestMatch(urlKeywords, products, collections, preferredType = null) {
    let bestMatch = null;
    let bestScore = 0;
    let matchType = null;

    // If we have a preferred type, search that type first and only return matches from that type
    if (preferredType === 'product') {
        console.log('Searching for product matches only (original URL was a product)');
        for (const product of products) {
            const score = calculateSimilarityScore(urlKeywords, product);
            if (score > bestScore) {
                bestScore = score;
                bestMatch = product;
                matchType = 'product';
            }
        }
    } else if (preferredType === 'collection') {
        console.log('Searching for collection matches only (original URL was a collection)');
        for (const collection of collections) {
            const score = calculateSimilarityScore(urlKeywords, collection);
            if (score > bestScore) {
                bestScore = score;
                bestMatch = collection;
                matchType = 'collection';
            }
        }
    } else {
        // No preference - search both (fallback behavior)
        console.log('No URL type preference - searching both products and collections');
        
        // Check products
        for (const product of products) {
            const score = calculateSimilarityScore(urlKeywords, product);
            if (score > bestScore) {
                bestScore = score;
                bestMatch = product;
                matchType = 'product';
            }
        }

        // Check collections
        for (const collection of collections) {
            const score = calculateSimilarityScore(urlKeywords, collection);
            if (score > bestScore) {
                bestScore = score;
                bestMatch = collection;
                matchType = 'collection';
            }
        }
    }

    // Only return match if score is above threshold
    if (bestScore > 0.3) {
        return {
            match: bestMatch,
            type: matchType,
            score: bestScore
        };
    }

    return null;
}

// Function to validate if a redirect URL exists in Shopify
function validateRedirectUrl(redirectUrl, products, collections) {
    // Remove leading slash if present
    const cleanUrl = redirectUrl.startsWith('/') ? redirectUrl.substring(1) : redirectUrl;
    
    // Check if it's a product URL
    if (cleanUrl.startsWith('products/')) {
        const handle = cleanUrl.replace('products/', '');
        return products.some(product => product.handle === handle);
    }
    
    // Check if it's a collection URL
    if (cleanUrl.startsWith('collections/')) {
        const handle = cleanUrl.replace('collections/', '');
        return collections.some(collection => collection.handle === handle);
    }
    
    // If it's just '/' (home page), it's always valid
    if (cleanUrl === '' || cleanUrl === '/') {
        return true;
    }
    
    return false;
}

// Function to find exact URL match in existing products/collections
function findExactUrlMatch(redirectFromUrl, products, collections) {
    try {
        const urlObj = new URL(redirectFromUrl);
        const pathname = urlObj.pathname;
        
        // Check if the URL points to a product
        const productMatch = pathname.match(/\/products\/([^\/\?]+)/);
        if (productMatch) {
            const handle = productMatch[1];
            const product = products.find(p => p.handle === handle);
            if (product) {
                return {
                    match: product,
                    type: 'product',
                    score: 1.0,
                    exactMatch: true
                };
            }
        }
        
        // Check if the URL points to a collection
        const collectionMatch = pathname.match(/\/collections\/([^\/\?]+)/);
        if (collectionMatch) {
            const handle = collectionMatch[1];
            const collection = collections.find(c => c.handle === handle);
            if (collection) {
                return {
                    match: collection,
                    type: 'collection',
                    score: 1.0,
                    exactMatch: true
                };
            }
        }
    } catch (error) {
        console.error('Error parsing URL for exact match:', error);
    }
    
    return null;
}

// Main function to process 404 redirects
async function process404Redirects() {
    console.log('Starting 404 redirect processing...');
    
    // Read data from Google Sheet
    const range = 'Sheet1!A:B'; // Assuming A = Redirect From, B = Redirect To
    const rows = await readGoogleSheet(range);
    
    if (!rows || rows.length === 0) {
        console.error('No data found in Google Sheet');
        return;
    }

    const [headers, ...dataRows] = rows;
    console.log(`Found ${dataRows.length} URLs to process`);

    // Fetch all products and collections from Shopify
    console.log('Fetching all products and collections from Shopify...');
    const [products, collections] = await Promise.all([
        fetchAllProducts(),
        fetchAllCollections()
    ]);

    console.log(`Loaded ${products.length} products and ${collections.length} collections`);

    // Process each URL
    for (let i = 0; i < dataRows.length; i++) {
        const row = dataRows[i];
        const redirectFromUrl = row[0];
        const existingRedirectTo = row[1];

        if (!redirectFromUrl) {
            console.log(`Skipping row ${i + 2}: No redirect from URL`);
            continue;
        }

        // Skip if redirect to is already filled
        if (existingRedirectTo && existingRedirectTo.trim() !== '') {
            console.log(`Skipping row ${i + 2}: Redirect To already filled`);
            continue;
        }

        console.log(`\n--- Processing Row ${i + 2} ---`);
        console.log(`Redirect From: ${redirectFromUrl}`);

        // Check if URL contains "abdos" keyword
        if (redirectFromUrl.toLowerCase().includes('abdos')) {
            console.log('Found "abdos" keyword - redirecting to home page');
            await updateRedirectTo(i + 1, '/');
            continue;
        }

        // First, try to find exact URL match (if the original URL structure exists in Shopify)
        const exactMatch = findExactUrlMatch(redirectFromUrl, products, collections);
        if (exactMatch && exactMatch.exactMatch) {
            const redirectUrl = exactMatch.type === 'product' 
                ? `/products/${exactMatch.match.handle}`
                : `/collections/${exactMatch.match.handle}`;
            
            console.log(`Found EXACT ${exactMatch.type} match: ${exactMatch.match.title}`);
            console.log(`Original URL structure exists in Shopify`);
            console.log(`Redirect To: ${redirectUrl}`);
            
            await updateRedirectTo(i + 1, redirectUrl);
            continue;
        }

        // Extract keywords from URL for similarity matching
        const urlKeywords = extractKeywordsFromUrl(redirectFromUrl);
        console.log(`Extracted keywords: ${urlKeywords.join(', ')}`);

        if (urlKeywords.length === 0) {
            console.log('No keywords found - redirecting to home page');
            await updateRedirectTo(i + 1, '/');
            continue;
        }

        // Determine the original URL type to preserve the same type in redirect
        const originalUrlType = getOriginalUrlType(redirectFromUrl);
        if (originalUrlType) {
            console.log(`Original URL type detected: ${originalUrlType}`);
        } else {
            console.log('Could not determine original URL type');
        }

        // Find best matching product or collection using similarity with type preference
        const bestMatch = findBestMatch(urlKeywords, products, collections, originalUrlType);

        if (bestMatch) {
            const redirectUrl = bestMatch.type === 'product' 
                ? `/products/${bestMatch.match.handle}`
                : `/collections/${bestMatch.match.handle}`;
            
            // Validate that the suggested URL actually exists
            const isValidUrl = validateRedirectUrl(redirectUrl, products, collections);
            
            if (isValidUrl) {
                console.log(`Found ${bestMatch.type} match: ${bestMatch.match.title}`);
                console.log(`Similarity score: ${bestMatch.score.toFixed(2)}`);
                if (originalUrlType && originalUrlType === bestMatch.type) {
                    console.log(`✓ URL type preserved: ${originalUrlType} → ${bestMatch.type}`);
                } else if (originalUrlType) {
                    console.log(`⚠ URL type changed: ${originalUrlType} → ${bestMatch.type} (no better match found in same type)`);
                }
                console.log(`Redirect To: ${redirectUrl} (URL validated as existing in Shopify)`);
                
                await updateRedirectTo(i + 1, redirectUrl);
            } else {
                console.log(`Found ${bestMatch.type} match: ${bestMatch.match.title}`);
                console.log(`Similarity score: ${bestMatch.score.toFixed(2)}`);
                console.log(`❌ ERROR: Suggested URL ${redirectUrl} does not exist in Shopify!`);
                console.log(`This should not happen - there may be a data synchronization issue`);
                console.log(`Redirecting to home page instead`);
                
                await updateRedirectTo(i + 1, '/');
            }
        } else {
            if (originalUrlType) {
                console.log(`No suitable ${originalUrlType} match found for original ${originalUrlType} URL`);
            } else {
                console.log('No suitable match found');
            }
            console.log('Redirecting to home page');
            await updateRedirectTo(i + 1, '/');
        }

        // Rate limiting to avoid overwhelming the API
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    console.log('\n404 redirect processing completed!');
}

// Endpoint to trigger the 404 redirect processing
app.get('/process-404-redirects', async (req, res) => {
    try {
        await process404Redirects();
        res.send('404 redirect processing completed successfully');
    } catch (error) {
        console.error('Error processing 404 redirects:', error);
        res.status(500).send('Error processing 404 redirects');
    }
});

// Validate required environment variables
function validateEnvironmentVariables() {
    const required = ['SHOPIFY_ADMIN_ACCESS_TOKEN', 'GOOGLE_SHEET_ID'];
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
    console.log(`- GET /process-404-redirects (Process 404 errors and create redirect mappings)`);

    // Validate environment variables at startup
    validateEnvironmentVariables();
});
