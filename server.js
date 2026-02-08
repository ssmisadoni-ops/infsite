// InfSite Backend Server
// This server handles website fetching and AI analysis to avoid CORS issues

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors()); // Enable CORS for all routes
app.use(express.json());
app.use(express.static('public')); // Serve static files from 'public' directory

// Helper function to validate URL
function isValidUrl(string) {
    try {
        const url = new URL(string);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch (_) {
        return false;
    }
}

// Helper function to normalize URL
function normalizeUrl(string) {
    try {
        return new URL(string).href;
    } catch (_) {
        try {
            return new URL('https://' + string).href;
        } catch (_) {
            return null;
        }
    }
}

// Extract text content from HTML
function extractTextContent(html, url) {
    const $ = cheerio.load(html);
    
    // Remove script, style, and other non-content elements
    $('script, style, noscript, iframe, svg').remove();
    
    // Extract metadata
    const metadata = {
        title: $('title').text().trim() || $('meta[property="og:title"]').attr('content') || '',
        description: $('meta[name="description"]').attr('content') || 
                    $('meta[property="og:description"]').attr('content') || '',
        url: url
    };
    
    // Extract headings
    const headings = [];
    $('h1, h2, h3').each((i, elem) => {
        const text = $(elem).text().trim();
        if (text && text.length < 200) {
            headings.push(text);
        }
    });
    
    // Extract main content
    // Try to find main content areas first
    let mainContent = '';
    const contentSelectors = ['main', 'article', '[role="main"]', '.content', '#content', '.main'];
    
    for (const selector of contentSelectors) {
        const content = $(selector).text();
        if (content && content.length > mainContent.length) {
            mainContent = content;
        }
    }
    
    // Fallback to body if no main content found
    if (!mainContent || mainContent.length < 100) {
        mainContent = $('body').text();
    }
    
    // Clean up the text
    mainContent = mainContent
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 8000); // Limit content length
    
    return {
        metadata,
        headings: headings.slice(0, 10), // First 10 headings
        content: mainContent
    };
}

// Analyze website endpoint
app.post('/api/analyze', async (req, res) => {
    try {
        const { url } = req.body;
        
        if (!url) {
            return res.status(400).json({ error: 'URL is required' });
        }
        
        // Validate and normalize URL
        const normalizedUrl = normalizeUrl(url);
        if (!normalizedUrl || !isValidUrl(normalizedUrl)) {
            return res.status(400).json({ error: 'Invalid URL provided' });
        }
        
        console.log(`Analyzing: ${normalizedUrl}`);
        
        // Fetch the website content
        let websiteData;
        try {
            const response = await axios.get(normalizedUrl, {
                timeout: 10000,
                maxRedirects: 5,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                }
            });
            
            websiteData = extractTextContent(response.data, normalizedUrl);
        } catch (fetchError) {
            console.error('Fetch error:', fetchError.message);
            return res.status(400).json({ 
                error: 'Unable to fetch website content. The site may be blocking automated access or is unreachable.'
            });
        }
        
        // Call Anthropic API for analysis
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
            // If no API key, return basic analysis
            return res.json({
                about: `${websiteData.metadata.title ? websiteData.metadata.title + ': ' : ''}${websiteData.metadata.description || 'A website that provides various content and services.'}`,
                purpose: 'This website serves as an online platform for information and services.',
                features: websiteData.headings.slice(0, 5).length > 0 
                    ? websiteData.headings.slice(0, 5)
                    : ['Content publishing', 'User interaction', 'Information sharing'],
                userActions: ['Browse content', 'Read information', 'Navigate pages'],
                metadata: websiteData.metadata
            });
        }
        
        // Prepare content for AI analysis
        const analysisPrompt = `Analyze this website and provide a structured response.

Website URL: ${websiteData.metadata.url}
Title: ${websiteData.metadata.title}
Meta Description: ${websiteData.metadata.description}

Main Headings:
${websiteData.headings.join('\n')}

Content Sample:
${websiteData.content.substring(0, 3000)}

Based on this information, provide:
1. A concise description of what the website is about (2-3 sentences)
2. The primary purpose of the website
3. 3-5 key features or main topics covered
4. 3-5 things users can do on this website

Return ONLY valid JSON (no markdown, no backticks) with this structure:
{
    "about": "description here",
    "purpose": "purpose here",
    "features": ["feature1", "feature2", "feature3"],
    "userActions": ["action1", "action2", "action3"]
}`;

        try {
            const aiResponse = await axios.post(
                'https://api.anthropic.com/v1/messages',
                {
                    model: 'claude-sonnet-4-20250514',
                    max_tokens: 1000,
                    messages: [{
                        role: 'user',
                        content: analysisPrompt
                    }]
                },
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'x-api-key': apiKey,
                        'anthropic-version': '2023-06-01'
                    }
                }
            );
            
            // Extract text from AI response
            let analysisText = '';
            if (aiResponse.data.content) {
                for (const block of aiResponse.data.content) {
                    if (block.type === 'text') {
                        analysisText += block.text;
                    }
                }
            }
            
            // Parse JSON response
            const cleanedText = analysisText.replace(/```json\n?|\n?```/g, '').trim();
            const analysis = JSON.parse(cleanedText);
            
            // Add metadata
            analysis.metadata = websiteData.metadata;
            
            res.json(analysis);
            
        } catch (aiError) {
            console.error('AI Analysis error:', aiError.message);
            
            // Return basic analysis if AI fails
            res.json({
                about: `${websiteData.metadata.title ? websiteData.metadata.title + ': ' : ''}${websiteData.metadata.description || 'A website providing various content and services.'}`,
                purpose: 'This website serves as an online platform.',
                features: websiteData.headings.slice(0, 5).length > 0 
                    ? websiteData.headings.slice(0, 5)
                    : ['Content publishing', 'Information sharing', 'User engagement'],
                userActions: ['Browse content', 'Read information', 'Navigate pages'],
                metadata: websiteData.metadata
            });
        }
        
    } catch (error) {
        console.error('Server error:', error);
        res.status(500).json({ 
            error: 'An error occurred while analyzing the website. Please try again.'
        });
    }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', message: 'InfSite API is running' });
});

// Start server
app.listen(PORT, () => {
    console.log(`InfSite backend server running on port ${PORT}`);
    console.log(`API endpoint: http://localhost:${PORT}/api/analyze`);
});
