const express = require('express');
const axios = require('../../config/axios');
const db = require('../../config/database');

const router = express.Router();

// API Base URL configuration - adapts to environment
// Uses HTTP for development, HTTPS for production
const DEFAULT_PROTOCOL = process.env.NODE_ENV === 'production' ? 'https' : 'http';
const DEFAULT_PORT = process.env.PORT || 3000;
const API_BASE_URL = process.env.API_BASE_URL || `${DEFAULT_PROTOCOL}://localhost:${DEFAULT_PORT}`;

// Request-level cache to prevent duplicate API calls within the same request
class RequestCache {
    constructor() {
        this.cache = new Map();
    }
    
    async get(key, fetchFn) {
        if (this.cache.has(key)) {
            console.log(`📦 Cache hit for: ${key}`);
            return this.cache.get(key);
        }
        
        console.log(`🌐 Cache miss, fetching: ${key}`);
        const result = await fetchFn();
        this.cache.set(key, result);
        return result;
    }
    
    clear() {
        this.cache.clear();
    }
}

// Helper function to format location display based on service type
function formatLocationDisplay(location, serviceType, radiusMiles) {
    if (!location) return 'Location TBD';
    
    const baseLocation = location;
    
    switch (serviceType) {
        case 'incall':
            return `${baseLocation} Incall`;
        
        case 'outcall':
            if (radiusMiles && radiusMiles > 0) {
                return `Outcall within ${radiusMiles} miles of ${baseLocation}`;
            }
            return `${baseLocation} Outcall`;
        
        case 'both':
            if (radiusMiles && radiusMiles > 0) {
                return `${baseLocation} Incall & Outcall within ${radiusMiles} miles`;
            }
            return `${baseLocation} Incall & Outcall`;
        
        default:
            return baseLocation;
    }
}

// Helper function to get model by slug using API call instead of direct SQL
async function getModelBySlug(slug) {
    try {
        const axios = require('../../config/axios');
        const response = await axios.get(`${API_BASE_URL}/api/model-profile/${slug}`);
        
        if (response.data.success && response.data.data) {
            console.log(`🔍 Loaded model profile via API for ${slug}`);
            return response.data.data;
        } else {
            console.log(`⚠️ Model not found via API: ${slug}`);
            return null;
        }
    } catch (error) {
        if (error.response && error.response.status === 404) {
            console.log(`⚠️ Model not found via API: ${slug}`);
            return null;
        }
        console.error(`❌ Error calling model profile API for ${slug}:`, error.message);
        return null;
    }
}

// Helper function to load dynamic colors using API instead of direct SQL queries
async function loadColorPalette(paletteId, themeId, modelId = 39, requestCache = null) {
    try {
        if (!paletteId && !themeId) {
            console.log('🎨 No palette or theme ID provided, using fallback colors');
            return { primary: '#3B82F6', secondary: '#6B7280', text: '#1F2937', background: '#FFFFFF', accent: '#10B981' };
        }

        const axios = require('../../config/axios');
        
        // If we have a specific palette ID (e.g., in preview mode), use the direct palette API
        // Otherwise use the model-specific API that considers the model's current settings
        let response;
        if (paletteId) {
            console.log(`🎨 Loading direct palette API for palette ${paletteId}`);
            response = requestCache 
                ? await requestCache.get(`color-palette-${paletteId}`, () => axios.get(`${API_BASE_URL}/api/color-palettes/${paletteId}`))
                : await axios.get(`${API_BASE_URL}/api/color-palettes/${paletteId}`);
        } else {
            console.log(`🎨 Loading model palette API for model ${modelId}`);
            response = requestCache 
                ? await requestCache.get(`model-colors-${modelId}`, () => axios.get(`${API_BASE_URL}/api/color-palettes/models/${modelId}/colors`))
                : await axios.get(`${API_BASE_URL}/api/color-palettes/models/${modelId}/colors`);
        }
        
        // Handle different response structures for different APIs
        let colors;
        if (response.data && response.data.data && response.data.data.colors) {
            // Direct palette API structure
            colors = response.data.data.colors;
            console.log(`🎨 Loaded direct palette API colors for palette ${paletteId}`);
        } else if (response.data && response.data.colors) {
            // Model palette API structure
            colors = response.data.colors;
            console.log(`🎨 Loaded model palette API colors for model ${modelId}`);
        } else {
            console.error('❌ No colors found in API response. Response structure:', JSON.stringify(response.data, null, 2));
            throw new Error('No colors found in API response');
        }
        
        if (colors) {
            
            // Apply the same normalization logic as the original function
            // Normalize legacy/variant token names to canonical schema
            const aliasToCanonical = {
                // brand
                'theme-primary': 'primary', 'brand-primary': 'primary',
                'theme-secondary': 'secondary',
                'theme-accent': 'accent', 'highlight': 'accent',
                // background/surface/overlay
                'background': 'bg', 'theme-background': 'bg',
                'surface': 'surface', 'card-background': 'surface', 'theme-surface': 'surface',
                'bg-primary': 'bg', 'bg-secondary': 'bg-light', 'bg-tertiary': 'surface',
                'hero-overlay': 'overlay', 'backdrop': 'overlay', 'theme-overlay': 'overlay',
                // text
                'theme-text': 'text', 'body-text': 'text',
                'theme-text-light': 'text-light', 'light-text': 'text-light',
                'theme-text-dark': 'text-dark', 'dark-text': 'text-dark',
                'text-default': 'text',
                // borders
                'theme-border': 'border', 'border-default': 'border',
                'theme-border-light': 'border-light',
                // cards
                'card-bg': 'card-bg', 'card-text': 'card-text', 'card-border': 'card-border', 'card-shadow': 'card-shadow',
                // nav/footer
                'nav-bg': 'nav-bg', 'nav-text': 'nav-text', 'nav-border': 'nav-border',
                'footer-bg': 'footer-bg', 'footer-text': 'footer-text', 'footer-border': 'footer-border',
                // buttons
                'btn-bg': 'btn-bg', 'btn-text': 'btn-text', 'btn-border': 'btn-border',
                'btn-bg-hover': 'btn-bg-hover', 'btn-text-hover': 'btn-text-hover',
                'btn-disabled-bg': 'btn-disabled-bg', 'btn-disabled-text': 'btn-disabled-text',
                // inputs
                'input-bg': 'input-bg', 'input-text': 'input-text', 'input-border': 'input-border', 'input-placeholder': 'input-placeholder', 'input-focus-ring': 'input-focus-ring',
                // hero
                'hero-bg': 'hero-bg', 'hero-text': 'hero-text',
                // misc
                'focus-ring': 'focus-ring', 'info': 'info', 'success': 'success', 'warning': 'warning', 'danger': 'danger',
            };

            const normalized = { ...colors };
            Object.entries(aliasToCanonical).forEach(([alias, canonical]) => {
                if (colors[alias] && !normalized[canonical]) {
                    normalized[canonical] = colors[alias];
                }
            });

            // Ensure key canonical tokens exist with sensible fallbacks
            const std = {
                primary: normalized['primary'] || '#3B82F6',
                secondary: normalized['secondary'] || '#6B7280',
                accent: normalized['accent'] || '#0EA5E9',
                bg: normalized['bg'] || normalized['surface'] || '#FFFFFF',
                'bg-light': normalized['bg-light'] || '#F8FAFC',
                'bg-dark': normalized['bg-dark'] || '#0B0B15',
                surface: normalized['surface'] || normalized['card-bg'] || '#FFFFFF',
                overlay: normalized['overlay'] || 'rgba(0,0,0,0.5)',
                text: normalized['text'] || '#1F2937',
                'text-light': normalized['text-light'] || '#E9E7F1',
                'text-dark': normalized['text-dark'] || '#0B0B15',
                border: normalized['border'] || '#E2E8F0',
                'border-light': normalized['border-light'] || '#C8D3E1',
                'card-bg': normalized['card-bg'] || normalized['surface'] || '#FFFFFF',
                'card-text': normalized['card-text'] || normalized['text'] || '#1F2937',
                'card-border': normalized['card-border'] || normalized['border'] || '#E2E8F0',
                'card-shadow': normalized['card-shadow'] || 'rgba(0,0,0,0.1)',
                'btn-bg': normalized['btn-bg'] || normalized['primary'] || '#3B82F6',
                'btn-bg-hover': normalized['btn-bg-hover'] || normalized['accent'] || '#2563EB',
                'btn-text': normalized['btn-text'] || '#FFFFFF',
                'btn-text-hover': normalized['btn-text-hover'] || '#0B0B15',
                'btn-border': normalized['btn-border'] || normalized['primary'] || '#3B82F6',
                'focus-ring': normalized['focus-ring'] || normalized['accent'] || '#3B82F6',
            };

            // Compose compatible colors used by legacy templates (do not overwrite canonical)
            const compatibleColors = {
                primary: std.primary,
                secondary: std.secondary,
                text: std.text,
                background: std.bg,
                accent: std.accent
            };

            // Log palette loading success with safe property access
            const paletteInfo = response.data?.palette?.id || response.data?.data?.palette?.id || paletteId || 'direct';
            const paletteSource = paletteId ? 'custom palette' : 'theme default';
            console.log(`🎨 Loaded color palette via API for model ${modelId}, palette ${paletteInfo}`);
            console.log('🎨 Compatible colors:', compatibleColors);
            console.log(`🎨 DEBUG: Final colors being applied from ${paletteSource}:`, {
                primary: compatibleColors.primary,
                secondary: compatibleColors.secondary,
                accent: compatibleColors.accent,
                background: compatibleColors.background,
                text: std.text,
                paletteId: paletteId,
                paletteSource: paletteSource
            });

            // Return full color object with both token-based and compatible colors
            return { ...normalized, ...std, ...compatibleColors };
        }

        console.log('🎨 No colors found via API, using fallback colors');
        return { primary: '#3B82F6', secondary: '#6B7280', text: '#1F2937', background: '#FFFFFF', accent: '#10B981' };

    } catch (error) {
        console.error(`❌ Error calling color palette API:`, error.message);
        return { primary: '#3B82F6', secondary: '#6B7280', text: '#1F2937', background: '#FFFFFF', accent: '#10B981' };
    }
}

// Helper function to get content with modelexample fallback
async function getContentWithFallback(modelSlug, pageType, requestCache = null) {
    try {
        // First try to get content for the current model
        let content = await getModelContent(modelSlug, pageType, requestCache);
        
        // If no content or empty content, fall back to modelexample
        if (!content || Object.keys(content).length === 0) {
            if (modelSlug !== 'modelexample') {
                console.log(`📋 No ${pageType} content for ${modelSlug}, using modelexample fallback`);
                content = await getModelContent('modelexample', pageType, requestCache);
                
                // Apply current model's specific data overrides
                if (content && Object.keys(content).length > 0) {
                    content = applyModelOverrides(content, modelSlug);
                }
            }
        }
        
        return content || {};
    } catch (error) {
        console.error(`❌ Error getting content with fallback for ${modelSlug}:`, error.message);
        return {};
    }
}

// Helper function to apply model-specific overrides to fallback content
function applyModelOverrides(content, modelSlug) {
    if (!content) return content;
    
    // Clone the content to avoid modifying the original
    const overriddenContent = { ...content };
    
    // Replace modelexample-specific references with current model
    const replaceModelReferences = (obj) => {
        if (typeof obj === 'string') {
            return obj
                .replace(/modelexample/g, modelSlug)
                .replace(/Model Example/g, modelSlug.charAt(0).toUpperCase() + modelSlug.slice(1))
                .replace(/\/modelexample\//g, `/${modelSlug}/`);
        } else if (typeof obj === 'object' && obj !== null) {
            const newObj = Array.isArray(obj) ? [] : {};
            for (const key in obj) {
                newObj[key] = replaceModelReferences(obj[key]);
            }
            return newObj;
        }
        return obj;
    };
    
    const processedContent = replaceModelReferences(overriddenContent);
    console.log(`🔄 Applied model overrides for ${modelSlug}`);
    
    return processedContent;
}

// Helper function to get model content for a specific page type using dedicated API endpoints
async function getModelContent(modelSlug, pageType, requestCache = null) {
    try {
        let content = {};
        
        if (pageType === 'home') {
            // Use model-home.js API
            try {
                const axios = require('../../config/axios');
                const response = await axios.get(`${API_BASE_URL}/api/model-home/${modelSlug}/home`);
                if (response.data.success) {
                    content = response.data.data;
                    console.log(`🏠 Loaded home content via API for ${modelSlug}`);
                } else {
                    console.log(`⚠️ No home content found via API for ${modelSlug}`);
                }
            } catch (error) {
                console.error(`❌ Error calling model-home API for ${modelSlug}:`, error.message);
            }
        } else if (pageType === 'about') {
            // Use model-about.js API
            try {
                const axios = require('../../config/axios');
                const response = await axios.get(`${API_BASE_URL}/api/model-about/${modelSlug}/about`);
                if (response.data.success && response.data.data) {
                    // About API returns {success: true, data: {...}}
                    // Return data directly since template expects about_content: pageContent
                    content = { ...response.data.data };
                    console.log(`📖 Loaded about content via API for ${modelSlug}`);
                } else {
                    console.log(`⚠️ No about content found via API for ${modelSlug}`);
                }
            } catch (error) {
                console.error(`❌ Error calling model-about API for ${modelSlug}:`, error.message);
            }
        } else if (pageType === 'rates') {
            // Use model-rates.js API (both rates data and page content)
            try {
                const axios = require('../../config/axios');
                
                // Helper function to convert underscore properties to camelCase for template compatibility
                function transformRatePropertiesToCamelCase(rateArray) {
                    return rateArray.map(rate => ({
                        ...rate,  // Keep all original properties
                        // Add camelCase aliases for template compatibility
                        serviceName: rate.service_name,
                        highlightBadge: rate.highlight_badge,
                        highlightBadgeText: rate.highlight_badge_text,
                        isMostPopular: rate.is_most_popular,
                        isVisible: rate.is_visible,
                        sortOrder: rate.sort_order
                    }));
                }
                
                // Get rates data (use cache if available)
                console.log(`🔍 DEBUG: About to call rates API for ${modelSlug} in getModelContent, cache exists: ${!!requestCache}`);
                const ratesResponse = requestCache 
                    ? await requestCache.get(`model-rates-${modelSlug}`, () => axios.get(`${API_BASE_URL}/api/model-rates/${modelSlug}`))
                    : await axios.get(`${API_BASE_URL}/api/model-rates/${modelSlug}`);
                
                // Get page content  
                const contentResponse = await axios.get(`${API_BASE_URL}/api/model-rates/${modelSlug}/page-content`);
                
                if (ratesResponse.data.success && contentResponse.data.success) {
                    const ratesData = ratesResponse.data.data;
                    
                    // Transform rate properties for template compatibility
                    const transformedRates = {
                        incall: transformRatePropertiesToCamelCase(ratesData.incall || []),
                        outcall: transformRatePropertiesToCamelCase(ratesData.outcall || []),
                        extended: transformRatePropertiesToCamelCase(ratesData.extended || [])
                    };
                    
                    // Combine rates data and page content
                    content = {
                        ...contentResponse.data.data,  // rates_content fields from page-content endpoint
                        rates: transformedRates, // transformed rates data for template compatibility
                        additionalServices: transformRatePropertiesToCamelCase(ratesData.additional || [])
                    };
                    console.log(`💰 Loaded rates content and data via API for ${modelSlug}`, {
                        incallCount: transformedRates.incall.length,
                        outcallCount: transformedRates.outcall.length,
                        extendedCount: transformedRates.extended.length,
                        sampleIncall: transformedRates.incall[0] ? {
                            serviceName: transformedRates.incall[0].serviceName,
                            service_name: transformedRates.incall[0].service_name,
                            price: transformedRates.incall[0].price
                        } : 'none'
                    });
                } else {
                    console.log(`⚠️ No rates content found via API for ${modelSlug}`);
                }
            } catch (error) {
                console.error(`❌ Error calling model-rates API for ${modelSlug}:`, error.message);
            }
        } else if (pageType === 'contact') {
            // Use model-contact.js API
            try {
                const axios = require('../../config/axios');
                const response = await axios.get(`${API_BASE_URL}/api/model-contact/${modelSlug}/content`);
                if (response.data && (response.data.id || response.data.model_id)) {
                    // Contact API returns raw data, not wrapped in success/data structure
                    // Return data directly since template expects contact_content: pageContent
                    content = { ...response.data };
                    console.log(`📞 Loaded contact content via API for ${modelSlug}`, Object.keys(content));
                } else {
                    console.log(`⚠️ No contact content found via API for ${modelSlug}`);
                }
            } catch (error) {
                console.error(`❌ Error calling model-contact API for ${modelSlug}:`, error.message);
            }
        } else if (pageType === 'etiquette') {
            // Use model-etiquette.js API
            try {
                const axios = require('../../config/axios');
                const response = await axios.get(`${API_BASE_URL}/api/model-etiquette/${modelSlug}/content`);
                if (response.data.success && response.data.data && response.data.data.etiquette_content) {
                    // Etiquette API returns {success: true, data: {etiquette_content: {...}}}
                    // Return the nested etiquette_content directly since template expects etiquette_content: pageContent
                    content = { ...response.data.data.etiquette_content };
                    console.log(`📋 Loaded etiquette content via API for ${modelSlug}`);
                } else {
                    console.log(`⚠️ No etiquette content found via API for ${modelSlug}`);
                }
            } catch (error) {
                console.error(`❌ Error calling model-etiquette API for ${modelSlug}:`, error.message);
            }
        } else if (pageType === "calendar") {
            // Use model-calendar.js API
            try {
                const axios = require('../../config/axios');
                const response = await axios.get(`${API_BASE_URL}/api/model-calendar/${modelSlug}`);
                if (response.data.success) {
                    content = response.data.data;
                    // Ensure we have the calendar_content prefix for template compatibility
                    const calendar_content = { ...content };
                    content = { calendar_content };
                    console.log(`📅 Loaded calendar content via API for ${modelSlug}`);
                } else {
                    console.log(`⚠️ No calendar content found via API for ${modelSlug}`);
                }
            } catch (error) {
                console.error(`❌ Error calling model-calendar API for ${modelSlug}:`, error.message);
            }
        } else if (pageType === 'gallery') {
            // Use model-gallery.js API
            try {
                const axios = require('../../config/axios');
                const response = await axios.get(`${API_BASE_URL}/api/model-gallery/${modelSlug}/sections`);
                if (response.data.success) {
                    content = response.data.data;
                    // Ensure we have the gallery_content prefix for template compatibility
                    const gallery_content = { ...content };
                    content = { gallery_content };
                    console.log(`🖼️ Loaded gallery content via API for ${modelSlug}`);
                } else {
                    console.log(`⚠️ No gallery content found via API for ${modelSlug}`);
                }
            } catch (error) {
                console.error(`❌ Error calling model-gallery API for ${modelSlug}:`, error.message);
            }
        } else {
            // Fallback to content_templates system via API for other page types
            try {
                const axios = require('../../config/axios');
                const response = await axios.get(`${API_BASE_URL}/api/content-templates/${modelSlug}/${pageType}`);
                
                if (response.data.success && response.data.data) {
                    content = { ...response.data.data };
                    console.log(`📋 Loaded ${pageType} content via content-templates API for ${modelSlug} (${response.data.meta.items_count} items)`);
                } else {
                    console.log(`⚠️ No content-templates found via API for ${modelSlug}/${pageType}`);
                }
            } catch (error) {
                console.error(`❌ Error calling content-templates API for ${modelSlug}/${pageType}:`, error.message);
            }
        }



        return content;
    } catch (error) {
        console.error('Error fetching content:', error);
        return {};
    }
}

// Main route handler for model pages
router.get('/:slug/:page?', async (req, res) => {
    try {
        const { slug, page = 'home' } = req.params;

        // Initialize request-level cache to prevent duplicate API calls
        const requestCache = new RequestCache();
        
        // Skip admin route
        if (slug === 'admin') {
            return res.redirect('/admin');
        }
        
        // Skip CRM route
        if (page === 'crm') {
            return; // Let the request continue to other routes
        }
        

        
        // Get model data
        const model = await getModelBySlug(slug);
        if (!model) {
            console.log(`❌ Model not found: ${slug}`);
            return res.status(404).send('Model not found');
        }
        

        
        // Store model in req for calendar visibility middleware
        req.model = model;
        
        // Check if calendar page is requested and if it's disabled
        if (page === 'calendar' && !res.locals.calendarEnabled) {
            console.log(`🚫 Calendar access denied for ${slug} - calendar is disabled`);
            return res.status(404).send('Page not found');
        }
        
        
        // Simple preview mode - just mask the database fields if URL parameters exist
        let isPreview = false;
        let previewThemeName = null;
        let previewThemeId = null; // Store preview theme ID for template
        
        if (req.query.preview_theme) {
            previewThemeId = parseInt(req.query.preview_theme);
            if (!isNaN(previewThemeId)) {
                // Verify theme exists before applying override using API
                try {
                    const axios = require('../../config/axios');
                    const response = await axios.get(`${API_BASE_URL}/api/theme-templates/validate/${previewThemeId}`);
                    
                    if (response.data.success && response.data.data) {
                        const themeCheck = response.data.data;
                        console.log(`🎭 Preview mode: overriding theme ${model.theme_set_id} -> ${previewThemeId} via API`);
                        model.theme_set_id = previewThemeId;
                        model.theme_name = themeCheck.name;
                        model.theme_display_name = themeCheck.display_name;
                        isPreview = true;
                        previewThemeName = themeCheck.display_name;
                        
                        // If no preview palette specified, use theme's default
                        if (!req.query.preview_palette && themeCheck.default_palette_id) {
                            console.log(`🎨 Using theme default palette: ${themeCheck.default_palette_id}`);
                            model.active_color_palette_id = themeCheck.default_palette_id;
                        }
                    } else {
                        console.log(`❌ Preview theme ${previewThemeId} not found via API, ignoring`);
                    }
                } catch (error) {
                    console.error('❌ Error checking preview theme via API:', error.message);
                }
            }
        }
        
        if (req.query.preview_palette) {
            const previewPaletteId = parseInt(req.query.preview_palette);
            if (!isNaN(previewPaletteId)) {
                // Verify palette exists before applying override using API
                try {
                    const axios = require('../../config/axios');
                    const response = await axios.get(`${API_BASE_URL}/api/theme-templates/validate-palette/${previewPaletteId}`);
                    
                    if (response.data.success && response.data.data) {
                        const paletteCheck = response.data.data;
                        console.log(`🎨 Preview mode: overriding palette ${model.active_color_palette_id} -> ${previewPaletteId} via API`);
                        model.active_color_palette_id = previewPaletteId;
                        model.palette_name = paletteCheck.name;
                        model.palette_display_name = paletteCheck.display_name;
                        isPreview = true;
                    } else {
                        console.log(`❌ Preview palette ${previewPaletteId} not found, ignoring`);
                    }
                } catch (error) {
                    console.error('❌ Error checking preview palette:', error);
                }
            }
        }
        
        // Check publication status for all pages (for both navigation and access control)
        const pageStatus = {
            home: true,
            about: true,
            gallery: true,
            rates: true,
            etiquette: true,
            calendar: true,
            contact: true
        };

        // Check publication status for all pages using API
        try {
            const axios = require('../../config/axios');
            const response = await axios.get(`${API_BASE_URL}/api/page-status/${slug}/status`);
            
            if (response.data.success && response.data.data.pages) {
                Object.assign(pageStatus, response.data.data.pages);
                console.log(`📄 Loaded page status via API for ${slug}`);
            } else {
                console.log(`⚠️ Could not load page status via API for ${slug}, using defaults`);
                // Default all pages to published if API fails
                pageStatus.home = true;
                pageStatus.about = true;
                pageStatus.gallery = true;
                pageStatus.rates = true;
                pageStatus.etiquette = true;
                pageStatus.calendar = true;
                pageStatus.contact = true;
            }
        } catch (error) {
            console.error(`❌ Error calling page status API for ${slug}:`, error.message);
            // Default all pages to published if API fails (fail open)
            pageStatus.home = true;
            pageStatus.about = true;
            pageStatus.gallery = true;
            pageStatus.rates = true;
            pageStatus.etiquette = true;
            pageStatus.calendar = true;
            pageStatus.contact = true;
        }

        // If requesting a specific page that's unpublished, return 404
        if (!pageStatus[page]) {
            console.log(`🚫 ${page.charAt(0).toUpperCase() + page.slice(1)} page for model ${model.id} is unpublished`);
            return res.status(404).send(`${page.charAt(0).toUpperCase() + page.slice(1)} page is not available`);
        }
        
        // Get content for this page using API calls with modelexample fallback
        const rawContent = await getContentWithFallback(slug, page, requestCache);
        

        
        // Map theme set names to our Handlebars theme names
        const themeMapping = {
            'basic': 'basic',
            'glamour': 'glamour',
            'escort_glamour': 'glamour',
            'camgirl_glamour': 'glamour', 
            'salon_glamour': 'glamour',
            'luxury': 'luxury',
            'modern': 'modern',
            'dark': 'dark',
            'rose': 'rose',
            'bdsm': 'bdsm',
            'royal-gem': 'royal-gem',
            'royal_gem': 'royal-gem',
            'royalgem': 'royal-gem',
            'Royal Gem': 'royal-gem',
            'simple-elegance': 'simple-elegance'
        };
        
        // Map theme name to handlebars template name
        const activeThemeName = model.theme_name;
        const themeName = themeMapping[activeThemeName] || 'basic';
        
        console.log(`🎨 Using theme: ${themeName} (mapped from "${activeThemeName}")${isPreview ? ' [PREVIEW MODE]' : ''}`);
        if (isPreview && previewThemeName) {
            console.log(`   - Preview theme: "${previewThemeName}"`);
        }
        
        // Load dynamic colors from color palette database
        const paletteId = model.active_color_palette_id;
        const themeId = model.theme_set_id;
        console.log(`🎨 Using palette ${paletteId}, theme ${themeId}${isPreview ? ' [PREVIEW]' : ''}`);
        console.log(`🎨 DEBUG: active_color_palette_id = ${paletteId === null ? 'NULL (using theme default)' : paletteId + ' (custom palette)'}`);
        console.log(`🎨 DEBUG: About to load colors for model ${model.id}, palette: ${paletteId}, theme: ${themeId}`);

        // Build preview query string for navigation links
        let previewQueryString = '';
        if (isPreview) {
            const params = new URLSearchParams();
            if (req.query.preview_theme) {
                params.append('preview_theme', req.query.preview_theme);
            }
            if (req.query.preview_palette) {
                params.append('preview_palette', req.query.preview_palette);
            }
            previewQueryString = params.toString() ? `?${params.toString()}` : '';
            console.log(`🔗 Preview query string: ${previewQueryString}`);
        }

        // Load dynamic colors from database
        const themeColors = await loadColorPalette(paletteId, themeId, model?.id || 39, requestCache);


        // Pre-load testimonials data using API
        let testimonialsData = null;
        if (page === 'home') {
            try {
                const axios = require('../../config/axios');
                const response = await axios.get(`${API_BASE_URL}/api/model-testimonials/${slug}`);
                console.log(`🔍 Testimonials API response:`, JSON.stringify(response.data, null, 2));
                if (response.data.success && response.data.data && response.data.data.testimonials) {
                    const rawTestimonials = response.data.data.testimonials;
                    console.log(`🔍 Raw testimonials count: ${rawTestimonials.length}`);
                    // Transform field names to match template expectations
                    testimonialsData = rawTestimonials.map(t => ({
                        name: t.client_name,
                        text: t.testimonial_text,
                        rating: t.rating,
                        date: t.created_at
                    }));
                    console.log(`📣 Loaded ${testimonialsData.length} testimonials via API for ${slug}`);
                } else {
                    testimonialsData = [];
                    console.log(`⚠️ No testimonials found in API response for ${slug}`);
                }
            } catch (error) {
                console.error(`❌ Error calling model-testimonials API for ${slug}:`, error.message);
                testimonialsData = [];
            }
        }

        // Pre-load services/rates data using API
        let servicesData = null;
        if (page === 'home') {
            try {
                const axios = require('../../config/axios');
                const response = await requestCache.get(`model-rates-${slug}`, () => 
                    axios.get(`${API_BASE_URL}/api/model-rates/${slug}`)
                );
                if (response.data.success && response.data.data.rates) {
                    // Use rates data as services for home page preview
                    const allRates = [...(response.data.data.rates.incall || []), ...(response.data.data.rates.outcall || [])];
                    servicesData = allRates.slice(0, 6).map(rate => ({
                        name: rate.rate_type || rate.serviceName,
                        description: rate.service_name || rate.description,
                        price: rate.price,
                        duration: rate.duration
                    }));
                    console.log(`💼 Loaded ${servicesData.length} services via API for ${slug}`);
                } else {
                    servicesData = [];
                }
            } catch (error) {
                console.error(`❌ Error calling model-rates API for services on ${slug}:`, error.message);
                servicesData = [];
            }
        }

        // Pre-load rates data for rates page using API
        if (page === 'rates' && rawContent) {
            try {
                if (!model) {
                    throw new Error('Model object is undefined');
                }
                
                console.log(`🔍 DEBUG: About to call rates API for ${slug} in rates page handler, cache exists: ${!!requestCache}`);
                const axios = require('../../config/axios');
                const response = await requestCache.get(`model-rates-${slug}`, () => 
                    axios.get(`${API_BASE_URL}/api/model-rates/${slug}`)
                );
                
                if (response.data.success && response.data.data) {
                    // Handle new API format with direct rate type arrays
                    const ratesData = response.data.data;
                    const allRates = [
                        ...(ratesData.incall || []),
                        ...(ratesData.outcall || []),
                        ...(ratesData.extended || [])
                    ];
                    console.log(`💰 Loaded ${allRates.length} rates via API for ${slug}`);
                    
                    // Use existing grouped format from API
                    const groupedRates = {
                        incall: ratesData.incall || [],
                        outcall: ratesData.outcall || [],
                        extended: ratesData.extended || []
                    };
                    
                    // Convert rate field names to camelCase for Handlebars template compatibility
                    const convertRateToHandlebars = (rate) => {
                        const converted = {};
                        Object.keys(rate).forEach(key => {
                            const camelKey = key.replace(/_([a-z])/g, (match, letter) => letter.toUpperCase());
                            converted[camelKey] = rate[key];
                        });
                        return converted;
                    };

                    const convertedRates = {
                        incall: groupedRates.incall.map(convertRateToHandlebars),
                        outcall: groupedRates.outcall.map(convertRateToHandlebars),
                        extended: groupedRates.extended.map(convertRateToHandlebars)
                    };

                    // Add rates to content
                    rawContent.rates = convertedRates;
                } else {
                    console.log(`⚠️ No rates found via API for ${slug}`);
                    rawContent.rates = { incall: [], outcall: [], extended: [] };
                }
            } catch (error) {
                console.error('Error loading rates data via API:', error.message);
                rawContent.rates = { incall: [], outcall: [], extended: [] };
            }
        }

        // Pre-load gallery images for home page preview using API
        let galleryImages = null;
        if (page === 'home') {
            try {
                const axios = require('../../config/axios');
                const response = await axios.get(`${API_BASE_URL}/api/gallery-images/${slug}/approved?limit=5`);
                
                if (response.data.success && response.data.data) {
                    galleryImages = response.data.data || [];
                    console.log(`🖼️ Loaded ${galleryImages.length} gallery images for home preview via API`);
                } else {
                    galleryImages = [];
                    console.log(`⚠️ No gallery images found via API for home preview`);
                }
            } catch (error) {
                console.error('Error loading gallery images:', error);
                galleryImages = [];
            }
        }

        // Pre-load upcoming calendar events for home pages using API
        let upcomingEvents = null;
        if (page === 'home') {
            try {
                // Get display count from content settings (default to 3 if not set)
                const displayCount = parseInt(rawContent.travel_display_count || 3);
                
                // Use calendar availability API instead of direct SQL
                const axios = require('../../config/axios');
                const response = await axios.get(`${API_BASE_URL}/api/model-calendar/${model.slug}/availability?days=90&limit=${displayCount}`);
                
                if (response.data.success && response.data.data && response.data.data.events) {
                    // Transform API response events for template compatibility
                    upcomingEvents = response.data.data.events.map(event => ({
                        id: event.id,
                        location: event.location, // Already formatted by API
                        baseLocation: event.location_details,
                        service_type: event.service_type,
                        radius_miles: event.radius_miles,
                        location_details: event.location_details,
                        date: new Date(event.start_date),
                        start_date: new Date(event.start_date),
                        end_date: new Date(event.end_date),
                        dateRange: event.date_range, // Already formatted by API
                        notes: event.notes,
                        is_available: event.is_available,
                        status: event.status
                    }));
                    
                    console.log(`📅 Loaded ${upcomingEvents.length} upcoming calendar events for ${model.slug}`);
                    console.log('📅 Calendar events:', upcomingEvents.map(e => ({ 
                        location: e.location, 
                        date: e.date, 
                        dateRange: e.dateRange
                    })));
                } else {
                    console.log(`⚠️ No calendar events found via API for ${model.slug}`);
                    upcomingEvents = [];
                }
            } catch (error) {
                console.error(`❌ Error calling calendar availability API for ${model.slug}:`, error.message);
                upcomingEvents = [];
            }
        }

        // Gallery data is now loaded through getModelContent for gallery pages
        let galleryData = null;

        // Transform content keys for template compatibility (after all data loading)  
        // Exception: etiquette, contact, about, rates, gallery, and home pages use snake_case field names for Handlebars templates
        const pageContent = {};
        if (page === 'etiquette' || page === 'contact' || page === 'about' || page === 'rates' || page === 'gallery' || page === 'home' || page === 'calendar') {
            // These pages use snake_case field names directly - no conversion needed
            Object.keys(rawContent).forEach(key => {
                pageContent[key] = rawContent[key];
            });
        } else {
            // Other pages need snake_case to camelCase conversion
            Object.keys(rawContent).forEach(key => {
                // Convert snake_case to camelCase
                const camelKey = key.replace(/_([a-z])/g, (match, letter) => letter.toUpperCase());
                pageContent[camelKey] = rawContent[key];
            });
        }
        
        // Load actual image URLs if IDs are provided using API
        const portraitIdKey = pageContent.portrait_image_id || pageContent.portraitImageId;
        if (portraitIdKey) {
            try {
                const axios = require('../../config/axios');
                // Get debug info first
                const debugResponse = await axios.get(`${API_BASE_URL}/api/gallery-images/debug/${portraitIdKey}`);
                console.log(`🔍 Found ${debugResponse.data.data.length} images with ID ${portraitIdKey} via API:`, debugResponse.data.data);
                
                // Get the actual approved image
                const response = await axios.get(`${API_BASE_URL}/api/gallery-images/${slug}/image/${portraitIdKey}`);
                
                if (response.data.success && response.data.data) {
                    const portraitImage = response.data.data;
                    console.log(`🔍 Portrait API result: image found`);
                    // Set both naming conventions for compatibility
                    const imageUrl = `/uploads/${model.slug}/public/gallery/${portraitImage.filename}`;
                    pageContent.portrait_image_url = imageUrl;
                    pageContent.portraitImageUrl = imageUrl;
                    console.log(`🖼️ Loaded portrait image via API: ${imageUrl}`);
                } else {
                    console.log(`❌ No portrait image found for ID ${portraitIdKey} via API`);
                }
            } catch (error) {
                console.error('Error loading portrait image via API:', error.message);
            }
        }
        
        const heroIdKey = pageContent.hero_background_image_id || pageContent.heroBackgroundImageId;
        if (heroIdKey) {
            try {
                const axios = require('../../config/axios');
                const response = await axios.get(`${API_BASE_URL}/api/gallery-images/${slug}/image/${heroIdKey}`);
                
                if (response.data.success && response.data.data) {
                    const heroImage = response.data.data;
                    // Set both naming conventions for compatibility
                    const imageUrl = `/uploads/${model.slug}/public/gallery/${heroImage.filename}`;
                    pageContent.hero_background_image_url = imageUrl;
                    pageContent.heroBackgroundImageUrl = imageUrl;
                    console.log(`🖼️ Loaded hero background image via API: ${imageUrl}`);
                }
            } catch (error) {
                console.error('Error loading hero background image via API:', error.message);
            }
        }

        // Fallback: Use home page hero background for all pages if no specific background is set
        if (!pageContent.heroBackgroundImageUrl) {
            try {
                const axios = require('../../config/axios');
                const response = await axios.get(`${API_BASE_URL}/api/gallery-images/${slug}/hero-background`);
                
                if (response.data.success && response.data.data) {
                    const heroData = response.data.data;
                    const imageUrl = `/uploads/${model.slug}/public/gallery/${heroData.filename}`;
                    pageContent.hero_background_image_url = imageUrl;
                    pageContent.heroBackgroundImageUrl = imageUrl;
                    console.log(`🖼️ Loaded fallback hero background image via API: ${imageUrl}`);
                }
            } catch (error) {
                console.error('Error loading fallback hero background image via API:', error.message);
            }
        }

        // Load portrait image for About page (snake_case field) using API
        if (pageContent.portrait_image_id) {
            try {
                const axios = require('../../config/axios');
                const response = await axios.get(`${API_BASE_URL}/api/gallery-images/${slug}/image/${pageContent.portrait_image_id}`);
                
                console.log(`🔍 About portrait API query result: ${response.data.success ? 'found' : 'not found'}`);
                if (response.data.success && response.data.data) {
                    const portraitImage = response.data.data;
                    pageContent.portraitImageUrl = `/uploads/${model.slug}/public/gallery/${portraitImage.filename}`;
                    console.log(`🖼️ Loaded about portrait image via API: ${pageContent.portraitImageUrl}`);
                } else {
                    console.log(`❌ No about portrait image found for ID ${pageContent.portrait_image_id} with model_id ${model.id} and is_active=1`);
                }
            } catch (error) {
                console.error('Error loading about portrait image:', error);
            }
        }
        
        // Prepare template data with real content
        const templateData = {
            model: {
                id: model.id,
                name: model.name,
                slug: model.slug,
                email: model.email || `${model.slug}@phoenix4ge.com`
            },
            content: pageContent,
            // Pass gallery sections directly to template context for gallery pages
            ...(page === 'gallery' && pageContent.gallerySections ? {
                gallerySections: pageContent.gallerySections
            } : {}),
            // Pass rates data directly for rates page  
            ...(page === 'rates' && pageContent.rates ? {
                rates: pageContent.rates
            } : {}),
            // Pass home content for home page (with modelexample fallback handled in getContentWithFallback)
            ...(page === 'home' ? { 
                home_content: pageContent
            } : {}),
            // Pass about content for about page
            ...(page === 'about' ? { about_content: pageContent } : {}),
            // Pass rates content for rates page
            ...(page === 'rates' ? { rates_content: pageContent } : {}),
            // Pass etiquette content for etiquette page
            ...(page === 'etiquette' ? { etiquette_content: pageContent } : {}),
            // Pass contact content for contact page
            ...(page === 'contact' ? { contact_content: pageContent } : {}),
            // Pass calendar content for calendar page
            ...(page === "calendar" ? { calendar_content: pageContent } : {}),
            // Pass gallery content for gallery page
            ...(page === 'gallery' ? { gallery_content: pageContent } : {}),
            
            // Template variables expected by themes
            siteName: model.name,
            modelSlug: model.slug,
            modelName: model.name,
            modelId: model.id,
            // Contact information for contact page
            contactEmail: model.email || `${model.slug}@phoenix4ge.com`,
            contactPhone: model.phone || null,
            location: pageContent.location || null,
            workingHours: pageContent.workingHours || null,
            // Theme colors for CSS variables
            theme: {
                name: themeName,
                colors: themeColors,
                isPreview: isPreview,
                previewThemeName: previewThemeName
            },
            
            
            // Navigation structure
            navigation: [
                ...(pageStatus.home ? [{ name: 'Home', url: `/${slug}${previewQueryString}`, active: page === 'home' }] : []),
                ...(pageStatus.about ? [{ name: 'About', url: `/${slug}/about${previewQueryString}`, active: page === 'about' }] : []),
                ...(pageStatus.gallery ? [{ name: 'Gallery', url: `/${slug}/gallery${previewQueryString}`, active: page === 'gallery' }] : []),
                ...(pageStatus.rates ? [{ name: 'Rates', url: `/${slug}/rates${previewQueryString}`, active: page === 'rates' }] : []),
                ...(pageStatus.etiquette ? [{ name: 'Etiquette', url: `/${slug}/etiquette${previewQueryString}`, active: page === 'etiquette' }] : []),
                ...(res.locals.calendarEnabled && pageStatus.calendar ? [{ name: 'Calendar', url: `/${slug}/calendar${previewQueryString}`, active: page === 'calendar' }] : []),
                ...(pageStatus.contact ? [{ name: 'Contact', url: `/${slug}/contact${previewQueryString}`, active: page === 'contact' }] : [])
            ],
            // Current page info
            currentPage: page,
            siteUrl: `/${slug}`,
            
            // Theme IDs for template
            themeId: model.theme_set_id,
            activePaletteId: model.active_color_palette_id, // Model's current custom palette (NULL = use theme default)
            previewThemeId: isPreview ? previewThemeId : null,
            previewPaletteId: isPreview && req.query.preview_palette ? parseInt(req.query.preview_palette) : null,
            previewParam: previewQueryString,
            // Preview object for template
            preview: {
                previewThemeId: isPreview ? previewThemeId : null,
                previewThemeName: previewThemeName,
                previewPaletteId: isPreview && req.query.preview_palette ? parseInt(req.query.preview_palette) : null
            },
            year: new Date().getFullYear(),
            // Gallery data (pre-loaded for gallery pages)
            galleries: galleryData,
            // Testimonials data (pre-loaded for home pages)
            testimonials: testimonialsData,
            // Services data (pre-loaded for home pages)
            services: servicesData,
            // Gallery images for home page preview
            galleryImages: galleryImages,
            // Upcoming calendar events for home page preview
            upcomingEvents: upcomingEvents
        };
        
        // Render using the assigned theme with layout and theme-specific partials
        
        // Query for the correct template file using API
        let templatePath = `${themeName}/pages/${page}`;
        try {
            // Use the model's theme_set_id (which may have been overridden in preview mode)
            const axios = require('../../config/axios');
            const response = await axios.get(`${API_BASE_URL}/api/theme-templates/${model.theme_set_id}/page/${page}`);
            
            if (response.data.success && response.data.data) {
                const templateData = response.data.data;
                if (templateData.template_file) {
                    // Remove leading slash, themes/ prefix, and .handlebars extension for templatePath
                    const templateFile = templateData.template_file;
                    templatePath = templateFile
                        .replace(/^\//, '')           // Remove leading slash
                        .replace(/^themes\//, '')     // Remove themes/ prefix 
                        .replace(/\.handlebars$/, ''); // Remove .handlebars extension
                    console.log(`🎨 Using API template: ${templateFile} -> ${templatePath}`);
                } else {
                    console.log(`🎨 No API template found for ${page}, using default: ${templatePath}`);
                }
            } else {
                console.log(`🎨 No API template data found for ${page}, using default: ${templatePath}`);
            }
        } catch (error) {
            console.error('❌ Error querying theme template:', error);
            console.log(`🎨 Falling back to default template: ${templatePath}`);
        }
        
        const layoutPath = `${themeName}/layouts/main`;

        
        // Create theme-specific app instance for proper partials resolution
        const { engine } = require('express-handlebars');
        const path = require('path');
        
        // Create a temporary Handlebars engine with theme-specific partials
        const themeEngine = engine({
            layoutsDir: path.join(__dirname, '../../themes'),
            partialsDir: path.join(__dirname, `../../themes/${themeName}/partials`),
            defaultLayout: false,
            extname: '.handlebars',
            helpers: {
                eq: (a, b) => a === b,
                ne: (a, b) => a !== b,
                lt: (a, b) => a < b,
                gt: (a, b) => a > b,
                and: (a, b) => a && b,
                repeat: (count, block) => {
                    let result = '';
                    for (let i = 0; i < count; i++) {
                        result += block.fn(this);
                    }
                    return result;
                },
                split: (str, delimiter) => {
                    return str ? str.split(delimiter) : [];
                },
                trim: (str) => {
                    return str ? str.trim() : '';
                },
                parseJSON: (str) => {
                    try {
                        return str ? JSON.parse(str) : [];
                    } catch (e) {
                        return [];
                    }
                },
                or: (a, b) => a || b,
                concat: (...args) => {
                    // Remove the last argument (options object from Handlebars)
                    const values = args.slice(0, -1);
                    return values.join('');
                },
                json: (context) => JSON.stringify(context),
                formatDate: (date) => new Date(date).toLocaleDateString(),
                formatCurrency: (amount) => `$${parseFloat(amount).toFixed(2)}`,
                truncate: (str, length = 100) => str && str.length > length ? str.substring(0, length) + '...' : str,
                // String helpers
                split: (str, delimiter) => str ? str.split(delimiter) : [],
                trim: (str) => str ? str.trim() : '',
                // Mathematical helpers
                multiply: (a, b) => a * b,
                times: function(n, options) {
                    let result = '';
                    for (let i = 0; i < n; i++) {
                        result += options.fn(this);
                    }
                    return result;
                },
                
                // Gallery helpers (Phase 5: Gallery Layouts)
                hasGalleries: function(modelSlug) {
                    return this.gallerySections && this.gallerySections.length > 0;
                },
                renderGalleries: function(modelSlug) {
                    if (!this.gallerySections) {
                        return '<div class="text-center py-16 text-gray-500">No gallery sections available</div>';
                    }
                    
                    return this.gallerySections.map((section, sectionIndex) => {
                        const layoutClass = section.layout_type === 'masonry' ? 'masonry-grid' : 
                                          section.layout_type === 'carousel' ? 'carousel-container' : 'grid-container';
                        
                        // Get carousel settings (available for all layout types)
                        const settings = section.layout_settings || {};
                        
                        let imagesHtml = '';
                        let navigationHtml = '';
                        
                        // Calculate carousel-specific values (even for non-carousel, set defaults)
                        const visibleItems = parseInt(settings.carouselItemsVisible || '1');
                        const itemWidth = 320;
                        const itemGap = 24;
                        // Calculate container width: (itemWidth * visibleItems) + gaps + padding
                        // Add extra space to ensure both images fit comfortably
                        const containerWidth = (itemWidth * visibleItems) + (itemGap * (visibleItems - 1)) + 100; // +100px for padding and safety
                        
                        if (section.images && section.images.length > 0) {
                            if (section.layout_type === 'carousel') {
                                
                                // Calculate total track width (all items + gaps)
                                const totalTrackWidth = (itemWidth * section.images.length) + (itemGap * (section.images.length - 1));
                                
                                // Generate carousel HTML with proper structure for multiple visible items
                                imagesHtml = `
                                    <div class="carousel-track" id="carousel-${sectionIndex}" data-current-index="0" 
                                         data-visible-items="${visibleItems}" data-item-width="${itemWidth}" data-item-gap="${itemGap}" style="gap: ${itemGap}px;">
                                        ${section.images.map((img, index) => {
                                            const imageUrl = `/uploads/${modelSlug}/public/gallery/${img.filename}`;
                                            const captionRaw = img.alt_text || img.caption || 'Gallery Image';
                                            const captionSafe = String(captionRaw).replace(/'/g, "\\'");
                                            return `
                                                <div class="carousel-item" style="width: ${itemWidth}px; max-width: ${itemWidth}px;">
                                                    <img src="${imageUrl}" 
                                                         alt="${captionRaw}"
                                                         data-full="${imageUrl}"
                                                         class="gallery-image"
                                                         onclick="(window.openLightbox||window.openDarkGalleryLightbox||window.openModernGalleryLightbox) && (window.openLightbox||window.openDarkGalleryLightbox||window.openModernGalleryLightbox)('${imageUrl}', '${captionSafe}')"
                                                         loading="lazy">
                                                    ${img.caption ? `<div class="image-caption">${img.caption}</div>` : ''}
                                                </div>
                                            `;
                                        }).join('')}
                                    </div>
                                `;
                                
                                // Add carousel navigation based on settings (support both old and new property names)
                                const showArrows = (settings.carouselArrows !== false) && (settings.carousel_controls !== false); // Default to true if not specified
                                const showDots = (settings.carouselDots !== false) && (settings.carousel_indicators !== false); // Default to true if not specified
                                
                                let navigationParts = [];
                                
                                // Add arrows if enabled
                                if (showArrows) {
                                    navigationParts.push(`
                                        <button class="carousel-nav prev" onclick="moveCarousel(${sectionIndex}, -1)" aria-label="Previous">
                                            <i class="fas fa-chevron-left"></i>
                                        </button>
                                        <button class="carousel-nav next" onclick="moveCarousel(${sectionIndex}, 1)" aria-label="Next">
                                            <i class="fas fa-chevron-right"></i>
                                        </button>
                                    `);
                                }
                                
                                // Add dots if enabled (calculate based on visible items)
                                if (showDots) {
                                    const totalPages = Math.ceil(section.images.length / visibleItems);
                                    const dotsArray = Array.from({length: totalPages}, (_, pageIndex) => {
                                        const slideIndex = pageIndex * visibleItems;
                                        return `
                                            <div class="carousel-dot ${pageIndex === 0 ? 'active' : ''}" 
                                                 onclick="goToCarouselSlide(${sectionIndex}, ${slideIndex})" 
                                                 data-slide="${slideIndex}"></div>
                                        `;
                                    });
                                    
                                    navigationParts.push(`
                                        <div class="carousel-dots">
                                            ${dotsArray.join('')}
                                        </div>
                                    `);
                                }
                                
                                navigationHtml = navigationParts.join('');
                            } else {
                                // Generate regular grid/masonry HTML
                                imagesHtml = section.images.map(img => {
                                    const imageUrl = `/uploads/${modelSlug}/public/gallery/${img.filename}`;
                                    const captionRaw = img.alt_text || img.caption || 'Gallery Image';
                                    const captionSafe = String(captionRaw).replace(/'/g, "\\'");
                                    return `
                                        <div class="gallery-item" data-aos="fade-up" data-aos-delay="${Math.random() * 300}">
                                            <img src="${imageUrl}" 
                                                 alt="${captionRaw}"
                                                 data-full="${imageUrl}"
                                                 class="gallery-image cursor-pointer hover:scale-105 transition-transform duration-300"
                                                 onclick="(window.openLightbox||window.openDarkGalleryLightbox||window.openModernGalleryLightbox) && (window.openLightbox||window.openDarkGalleryLightbox||window.openModernGalleryLightbox)('${imageUrl}', '${captionSafe}')"
                                                 loading="lazy">
                                            ${img.caption ? `<div class="image-caption">${img.caption}</div>` : ''}
                                        </div>
                                    `;
                                }).join('');
                            }
                        } else {
                            imagesHtml = '<div class="text-center py-8 text-gray-400">No images in this section</div>';
                        }
                        
                        // Generate data-autoplay attribute for carousel
                        let autoplayAttr = '';
                        if (section.layout_type === 'carousel') {
                            const autoplayEnabled = settings.carouselAutoplay || settings.carousel_autoplay;
                            const autoplaySpeed = settings.carouselSpeed || settings.carousel_speed || '5000';
                            autoplayAttr = autoplayEnabled ? ` data-autoplay="${autoplaySpeed}"` : ' data-autoplay="0"';
                        }
                        
                        // If carousel: wrap track in a viewport with explicit width and overflow hidden
                        const contentHtml = section.layout_type === 'carousel'
                            ? `<div class="carousel-viewport" style="width: ${containerWidth}px; margin: 0 auto; overflow: hidden;">${imagesHtml}</div>${navigationHtml}`
                            : `${imagesHtml}${navigationHtml}`;
                        
                        return `
                            <div class="gallery-section mb-12">
                                <div class="text-center mb-8">
                                    <h2 class="text-3xl font-bold text-blue-600 mb-2">${section.title}</h2>
                                    ${section.description ? `<p class="text-gray-600 max-w-2xl mx-auto">${section.description}</p>` : ''}
                                    <div class="text-sm text-gray-500 mt-2">${section.images ? section.images.length : 0} images • ${section.layout_type} layout</div>
                                </div>
                                <div class="${layoutClass}"${autoplayAttr}>
                                    ${contentHtml}
                                </div>
                            </div>
                        `;
                    }).join('');
                },
                renderGallerySection: function(modelSlug, sectionSlug) {
                    const section = this.gallerySections ? 
                        this.gallerySections.find(s => s.slug === sectionSlug) : null;
                    return section ? this.renderGalleries(modelSlug) : `<div class="gallery-not-found">Gallery section "${sectionSlug}" not found</div>`;
                },
                renderGalleryByType: function(modelSlug, layoutType) {
                    const section = this.gallerySections ? 
                        this.gallerySections.find(s => s.layout_type === layoutType) : null;
                    return section ? this.renderGalleries(modelSlug) : `<div class="gallery-not-found">No ${layoutType} gallery found</div>`;
                },
                getFeaturedGalleryImages: function(modelSlug, limit = 6) {
                    if (!this.gallerySections) return [];
                    
                    const allImages = [];
                    this.gallerySections.forEach(section => {
                        if (section.images) {
                            allImages.push(...section.images);
                        }
                    });
                    
                    return allImages.slice(0, limit);
                }
            }
        });
        
        // Render with theme-specific engine
        const viewPath = path.join(__dirname, `../../themes/${templatePath}.handlebars`);
        
        // Debug completed - field name conversion fix applied

        
        themeEngine(viewPath, {
            ...templateData,
            // Add heroBackgroundImageUrl at top level for BDSM theme compatibility
            heroBackgroundImageUrl: pageContent.heroBackgroundImageUrl,
            layout: layoutPath
        }, (err, html) => {
            if (err) {
                console.error('❌ Template rendering error:', err);
                res.status(500).send('Template rendering error');
            } else {
                res.send(html);
            }
        });
        
    } catch (error) {
        console.error('❌ Error in model site route:', error);
        res.status(500).send('Internal server error');
    }
});

// Route for homepage (redirects to home page)
router.get('/:slug', async (req, res) => {
    res.redirect(`/${req.params.slug}/home`);
});

module.exports = router;
