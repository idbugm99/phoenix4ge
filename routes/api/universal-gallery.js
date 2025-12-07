/**
 * Universal Gallery API Routes - Profile Management System
 * 
 * API endpoints for managing gallery profiles and business type assignments
 * Master controller for gallery functionality across all business types
 */

const express = require('express');
const router = express.Router();
const mysql = require('mysql2/promise');

// Database connection
async function getDbConnection() {
    return mysql.createConnection({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_DATABASE || 'phoenix4ge',
        timezone: '+00:00'
    });
}

// GET /api/universal-gallery/profiles - Get all gallery profiles
router.get('/profiles', async (req, res) => {
    let db;
    try {
        db = await getDbConnection();
        
        const [profiles] = await db.execute(`
            SELECT * FROM gallery_profiles 
            ORDER BY is_system_default DESC, profile_display_name ASC
        `);
        
        res.json(profiles);
        
    } catch (error) {
        console.error('Error fetching gallery profiles:', error);
        res.status(500).json({ 
            error: 'Failed to fetch gallery profiles',
            message: error.message 
        });
    } finally {
        if (db) await db.end();
    }
});

// ===== Gallery Data Loading Endpoint =====

/**
 * GET /api/universal-gallery/config
 * Get complete gallery configuration and data for a model (for frontend JavaScript)
 * 
 * Query Parameters:
 * - model (required): Model slug
 * - preview_theme (optional): Preview theme ID
 * - page (optional): Page number for pagination
 * - category (optional): Filter by category
 * - sort (optional): Sort order (recent, oldest, featured, popular)
 * - layout (optional): Force specific layout type
 */
router.get('/config', async (req, res) => {
    let db;
    try {
        db = await getDbConnection();
        const { 
            model: modelSlug, 
            preview_theme: previewTheme, 
            page = 1, 
            category = null, 
            sort = 'recent', 
            layout = null 
        } = req.query;
        
        if (!modelSlug) {
            return res.status(400).json({
                success: false,
                error: 'Model slug is required'
            });
        }
        
        console.log(`🎨 Loading universal gallery config for: ${modelSlug}`);
        
        // Get model and theme information
        const [modelData] = await db.execute(`
            SELECT 
                m.id, m.slug, m.name, 
                COALESCE(bt.name, 'default') as business_model,
                COALESCE(ts.id, 1) as theme_set_id, 
                COALESCE(ts.name, 'basic') as theme_name,
                COALESCE(?, ts.id, 1) as effective_theme_id
            FROM models m
            LEFT JOIN theme_sets ts ON m.theme_set_id = ts.id
            LEFT JOIN business_types bt ON bt.id = m.business_type_id
            WHERE m.slug = ?
        `, [previewTheme || null, modelSlug]);

        if (modelData.length === 0) {
            return res.status(404).json({
                success: false,
                error: `Model not found: ${modelSlug}`
            });
        }

        const model = modelData[0];
        
        // Get gallery page configuration including selected sections and hero settings
        const [galleryPageData] = await db.execute(`
            SELECT 
                page_title,
                page_subtitle,
                gallery_header_visible,
                selected_sections,
                enable_lightbox,
                show_captions,
                images_per_page,
                default_layout
            FROM model_gallery_page_content 
            WHERE model_id = ?
        `, [model.id]);

        const galleryConfig = galleryPageData[0] || {};
        let selectedSectionIds = [];
        
        // Safely parse selected_sections JSON
        if (galleryConfig.selected_sections) {
            try {
                const sectionsData = galleryConfig.selected_sections;
                console.log('🔍 Raw selected_sections data:', JSON.stringify(sectionsData));
                
                if (typeof sectionsData === 'string') {
                    selectedSectionIds = JSON.parse(sectionsData);
                } else if (Array.isArray(sectionsData)) {
                    selectedSectionIds = sectionsData;
                } else {
                    console.warn('⚠️ selected_sections is neither string nor array:', typeof sectionsData);
                    selectedSectionIds = [];
                }
            } catch (parseError) {
                console.error('❌ Failed to parse selected_sections JSON:', parseError.message);
                console.error('Raw data:', galleryConfig.selected_sections);
                selectedSectionIds = [];
            }
        }
        
        // Get gallery sections from the new table structure, filtering by selected sections
        let sectionsQuery, sectionsParams;
        if (selectedSectionIds.length > 0) {
            const placeholders = selectedSectionIds.map(() => '?').join(',');
            sectionsQuery = `
                SELECT 
                    id,
                    section_name,
                    section_slug,
                    section_description,
                    layout_type,
                    layout_settings,
                    section_order,
                    is_published,
                    is_featured
                FROM model_gallery_sections
                WHERE model_slug = ? 
                AND is_published = 1
                AND id IN (${placeholders})
                ORDER BY FIELD(id, ${placeholders})
            `;
            sectionsParams = [modelSlug, ...selectedSectionIds, ...selectedSectionIds];
        } else {
            // If no selected sections, show all published sections (default behavior)
            sectionsQuery = `
                SELECT 
                    id,
                    section_name,
                    section_slug,
                    section_description,
                    layout_type,
                    layout_settings,
                    section_order,
                    is_published,
                    is_featured
                FROM model_gallery_sections
                WHERE model_slug = ? 
                AND is_published = 1
                ORDER BY section_order ASC, id ASC
            `;
            sectionsParams = [modelSlug];
        }
        
        const [sections] = await db.execute(sectionsQuery, sectionsParams);
        
        // Helper: normalize layout_settings from admin to renderer format
        function normalizeLayoutSettings(layoutType, settingsRaw) {
            try {
                let settings = settingsRaw;
                if (!settings) return {};
                if (typeof settings === 'string') {
                    try { settings = JSON.parse(settings); } catch { settings = {}; }
                }
                if (typeof settings !== 'object' || settings === null) return {};

                const out = {};
                const numPx = (val, fallback) => {
                    if (val === undefined || val === null || val === '') return fallback;
                    const n = Number(val);
                    if (!Number.isFinite(n)) return fallback;
                    return `${n}px`;
                };

                switch (layoutType) {
                    case 'grid':
                        out.columns = settings.gridColumns ?? settings.columns ?? 4;
                        out.gap = numPx(settings.gridGap ?? settings.gap, '1.5rem');
                        // extras are ignored by renderer but keep for future
                        break;
                    case 'masonry':
                        out.columns = settings.masonryColumns ?? settings.columns ?? 3;
                        out.gap = numPx(settings.masonryGap ?? settings.gap, '1.5rem');
                        break;
                    case 'carousel':
                        out.visible_items = settings.carouselItemsVisible ?? settings.visible_items ?? 1;
                        out.show_dots = settings.carouselDots ?? settings.show_dots ?? true;
                        out.show_arrows = settings.carouselArrows ?? settings.show_arrows ?? true;
                        out.auto_play = settings.carouselAutoplay ?? settings.auto_play ?? false;
                        out.auto_play_speed = settings.carouselSpeed ?? settings.auto_play_speed ?? 3000;
                        break;
                    case 'slideshow':
                        out.slideshow_autoplay = settings.slideshowAutoplay ?? settings.slideshow_autoplay ?? true;
                        out.slideshow_speed = settings.slideshowSpeed ?? settings.slideshow_speed ?? 5000;
                        out.show_dots = settings.slideshowDots ?? settings.show_dots ?? true;
                        out.show_arrows = settings.slideshowArrows ?? settings.show_arrows ?? true;
                        out.show_captions = settings.show_captions ?? true;
                        break;
                    case 'lightbox_grid':
                        out.columns = settings.lightboxColumns ?? settings.columns ?? 6;
                        break;
                    default:
                        // fallback passthrough
                        Object.assign(out, settings);
                }
                return out;
            } catch (e) {
                return {};
            }
        }

        // Get gallery items organized by sections
        const gallerySections = [];
        if (sections && sections.length > 0) {
            
            // Process each section separately using new model_gallery_section_media table
            for (const section of sections) {
                const [items] = await db.execute(`
                    SELECT 
                        ml.id,
                        ml.filename,
                        ml.original_filename,
                        ml.permanent_path as file_url,
                        ml.thumbnail_path,
                        ml.medium_path,
                        ml.image_width,
                        ml.image_height,
                        ml.upload_date,
                        'approved' as moderation_status,
                        'public' as visibility_status,
                        mgsm.custom_caption,
                        mgsm.display_order,
                        mgsm.is_featured
                    FROM model_gallery_section_media mgsm
                    JOIN model_media_library ml ON mgsm.media_id = ml.id
                    WHERE mgsm.section_id = ?
                    AND ml.model_slug = ?
                    AND ml.processing_status = 'completed'
                    AND ml.moderation_status IN ('approved', 'pending')
                    AND ml.is_deleted = 0
                    ORDER BY mgsm.display_order ASC, ml.upload_date DESC
                `, [section.id, modelSlug]);
                
                // Process items for this section with model slug prefix for proper routing
                const sectionItems = items.map(item => {
                    // Build correct URLs with model slug
                    const baseUrl = `/uploads/${modelSlug}`;
                    const originalFilename = item.original_filename || item.filename;
                    
                    // Construct proper URLs based on the actual file structure
                    const fullUrl = `${baseUrl}/originals/${item.filename}`;
                    const mediumUrl = `${baseUrl}/public/gallery/${item.filename}`;
                    const thumbUrl = `${baseUrl}/thumbs/${item.filename}`;
                    
                    // Fallback to full image if others don't exist
                    // (In production, you'd check file existence, but for now we assume the structure)
                    
                    return {
                        id: item.id.toString(),
                        alt: item.custom_caption || originalFilename || 'Gallery image',
                        caption: item.custom_caption || null,
                        srcThumb: thumbUrl,
                        srcMed: mediumUrl,
                        srcFull: fullUrl,
                        aspect: item.image_width && item.image_height ? 
                            item.image_width / item.image_height : 1,
                        width: item.image_width,
                        height: item.image_height,
                        uploadDate: item.upload_date,
                        featured: Boolean(item.is_featured),
                        flagged: item.moderation_status === 'flagged'
                    };
                });

                // Normalize layout settings per layout type
                const normalizedSettings = normalizeLayoutSettings(section.layout_type, section.layout_settings);

                // Add this section to the gallery sections array
                gallerySections.push({
                    id: section.id,
                    name: section.section_name,
                    slug: section.section_slug,
                    description: section.section_description,
                    layout: section.layout_type,
                    layoutSettings: normalizedSettings,
                    order: section.section_order,
                    featured: Boolean(section.is_featured),
                    items: sectionItems,
                    itemCount: sectionItems.length
                });
            }
        }
        
        // Get categories from sections
        const categories = sections.map(s => s.section_name);
        
        // Calculate totals across all sections
        const totalImages = gallerySections.reduce((sum, section) => sum + section.itemCount, 0);
        
        // Structure the response
        const response = {
            success: true,
            config: {
                // Configuration metadata
                metadata: {
                    model_id: model.id,
                    model_slug: model.slug,
                    model_name: model.name,
                    business_model: model.business_model,
                    theme_name: model.theme_name,
                    theme_set_id: model.theme_set_id,
                    effective_theme_id: model.effective_theme_id,
                    generated_at: new Date().toISOString()
                },

                // Hero section configuration
                hero: {
                    enabled: Boolean(galleryConfig.gallery_header_visible),
                    title: galleryConfig.page_title || model.name + " Gallery",
                    subtitle: galleryConfig.page_subtitle || null
                },
                
                // Mock CSS variables based on theme
                css_variables: getThemeCSSVariables(model.theme_name),
                
                // Mock settings
                gallery_settings: {
                    default_layout: (layout && layout !== 'null' && layout !== 'undefined') ? layout : 'masonry',
                    total_sections: gallerySections.length,
                    grid_columns_desktop: 4,
                    enable_lightbox: true,
                    show_captions: true
                },
                accessibility: {
                    keyboard_navigation: true,
                    aria_labels: true,
                    screen_reader_support: true
                },
                carousel: {
                    autoplay: false,
                    autoplaySpeed: 3000
                }
            },
            data: {
                sections: gallerySections,
                totalSections: gallerySections.length,
                totalImages: totalImages,
                categories: categories,
                settings: {
                    lightbox: true,
                    fullscreen: true,
                    captions: true,
                    imageInfo: false,
                    sectionHeaders: true,
                    navigationMenu: true,
                    gridCols: {
                        sm: 2,
                        md: 3,
                        lg: 4
                    },
                    carousel: {
                        autoplay: false,
                        autoplaySpeed: 3000,
                        showDots: true,
                        showArrows: true
                    }
                }
            },
            timestamp: new Date().toISOString()
        };
        
        console.log(`✅ Gallery config loaded for ${modelSlug}: ${gallerySections.length} sections, ${totalImages} total images`);
        
        res.json(response);
        
    } catch (error) {
        console.error('❌ Error loading universal gallery config:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Internal server error',
            timestamp: new Date().toISOString()
        });
    } finally {
        if (db) await db.end();
    }
});

// Helper function to get theme-specific CSS variables
function getThemeCSSVariables(themeName) {
    const themeVariables = {
        basic: {
            primary_color: '#2563eb',
            secondary_color: '#64748b',
            accent_color: '#0ea5e9',
            background: '#ffffff',
            text: '#1e293b',
            border_radius: '8px'
        },
        glamour: {
            primary_color: '#E9C77A',
            secondary_color: '#D08770',
            accent_color: '#EBCB8B',
            background: 'linear-gradient(145deg, #171228, #1E1632)',
            text: '#F3EFE7',
            border_radius: '15px'
        },
        modern: {
            primary_gradient: 'linear-gradient(135deg, #6366f1, #06b6d4)',
            secondary_gradient: 'linear-gradient(135deg, #0f172a, #334155)',
            accent_color: '#6366f1',
            background: 'linear-gradient(135deg, #f8fafc, #ffffff)',
            text: '#0f172a',
            border_radius: '16px'
        },
        luxury: {
            primary_color: '#ffd700',
            secondary_color: '#cd9500',
            accent_color: '#ffed4e',
            background: 'linear-gradient(135deg, #f8f6f0, #e8dcc0)',
            text: '#1a1a2e',
            border_radius: '12px'
        },
        dark: {
            primary_color: '#8b5cf6',
            secondary_color: '#6b46c1',
            accent_color: '#a855f7',
            background: '#111827',
            text: '#f9fafb',
            border_radius: '8px'
        }
    };
    
    return themeVariables[themeName] || themeVariables.basic;
}

// ===== System Configuration Endpoints =====

/**
 * GET /api/universal-gallery/config/system
 * Get current system configuration
 */
router.get('/config/system', async (req, res) => {
    try {
        // Return mock configuration for now
        const config = galleryService.getSystemConfig();
        res.json(config);
        
    } catch (error) {
        handleApiError(error, res);
    }
});

/**
 * PUT /api/universal-gallery/config/system
 * Update system configuration
 */
router.put('/config/system', async (req, res) => {
    try {
        const config = req.body;
        
        // Validate configuration (basic validation for now)
        const validationResult = validator.validateConfig(config);
        if (!validationResult.isValid) {
            return res.status(400).json({
                error: 'Configuration validation failed',
                errors: validationResult.errors
            });
        }
        
        // Update the mock service configuration (in a real app, this would save to database)
        Object.assign(galleryService.getSystemConfig(), config);
        
        
        res.json({ 
            success: true, 
            message: 'System configuration updated successfully',
            config: config
        });
        
    } catch (error) {
        handleApiError(error, res);
    }
});

/**
 * GET /api/universal-gallery/config/defaults
 * Get factory default configuration
 */
router.get('/config/defaults', async (req, res) => {
    try {
        const defaultConfig = {
            defaultLayout: 'masonry',
            imagesPerPage: 20,
            gridColumns: 4,
            enableLightbox: true,
            enableFullscreen: true,
            enableZoom: true,
            lightboxAnimation: 'fade',
            showCaptions: true,
            showImageInfo: false,
            showCategoryFilter: true,
            enableSearch: false,
            enableLazyLoading: true,
            enablePrefetch: true,
            prefetchStrategy: 'balanced',
            respectReducedMotion: true
        };
        
        res.json(defaultConfig);
        
    } catch (error) {
        handleApiError(error, res);
    }
});

// ===== Theme Configuration Endpoints =====

/**
 * GET /api/universal-gallery/themes
 * Get all available themes
 */
router.get('/themes', async (req, res) => {
    try {
        // Return mock themes data based on existing themes
        const themes = [
            { id: 1, name: 'basic', display_name: 'Template 1 - Basic', description: 'Clean and simple gallery layout', category: 'free', pricing_tier: 'basic', is_active: true, page_count: 5 },
            { id: 2, name: 'glamour', display_name: 'Template 2 - Glamour', description: 'Elegant gallery with sophisticated styling', category: 'premium', pricing_tier: 'premium', is_active: true, page_count: 5 },
            { id: 3, name: 'luxury', display_name: 'Template 3 - Luxury', description: 'Royal gallery with gold accents', category: 'premium', pricing_tier: 'premium', is_active: true, page_count: 5 },
            { id: 4, name: 'modern', display_name: 'Template 4 - Modern', description: 'Contemporary design with clean lines', category: 'premium', pricing_tier: 'premium', is_active: true, page_count: 5 },
            { id: 5, name: 'dark', display_name: 'Template 5 - Dark', description: 'Cyberpunk theme with neon effects', category: 'premium', pricing_tier: 'premium', is_active: true, page_count: 5 }
        ];
        
        res.json(themes);
        
    } catch (error) {
        handleApiError(error, res);
    }
});

/**
 * GET /api/universal-gallery/themes/:themeId/config
 * Get theme-specific configuration
 */
router.get('/themes/:themeId/config', async (req, res) => {
    let db;
    try {
        db = await getDbConnection();
        const { themeId } = req.params;
        
        // Check if theme exists
        const [themeRows] = await db.execute(
            'SELECT * FROM theme_sets WHERE id = ? OR name = ?',
            [themeId, themeId]
        );
        
        if (themeRows.length === 0) {
            return res.status(404).json({
                error: 'Theme not found',
                message: `Theme "${themeId}" does not exist`
            });
        }
        
        // Get theme configuration from universal_gallery_configs
        const [configRows] = await db.execute(
            'SELECT config_json FROM universal_gallery_configs WHERE config_name = ? AND is_active = TRUE',
            [`${themeRows[0].name}_theme_config`]
        );
        
        let config = {};
        if (configRows.length > 0) {
            config = JSON.parse(configRows[0].config_json);
        }
        
        res.json({
            theme: themeRows[0],
            config: config
        });
        
    } catch (error) {
        handleApiError(error, res);
    } finally {
        if (db) await db.end();
    }
});

/**
 * PUT /api/universal-gallery/themes/:themeId/config
 * Update theme-specific configuration
 */
router.put('/themes/:themeId/config', async (req, res) => {
    let db;
    try {
        db = await getDbConnection();
        const { themeId } = req.params;
        const config = req.body;
        
        // Check if theme exists
        const [themeRows] = await db.execute(
            'SELECT * FROM theme_sets WHERE id = ? OR name = ?',
            [themeId, themeId]
        );
        
        if (themeRows.length === 0) {
            return res.status(404).json({
                error: 'Theme not found',
                message: `Theme "${themeId}" does not exist`
            });
        }
        
        const theme = themeRows[0];
        
        // Validate configuration
        const validationResult = await validator.validateConfig(config);
        if (!validationResult.valid) {
            return res.status(400).json({
                error: 'Theme configuration validation failed',
                errors: validationResult.errors
            });
        }
        
        // Update theme configuration
        await db.execute(`
            INSERT INTO universal_gallery_configs (config_name, config_json, description, updated_at)
            VALUES (?, ?, ?, NOW())
            ON DUPLICATE KEY UPDATE 
                config_json = VALUES(config_json),
                updated_at = NOW()
        `, [
            `${theme.name}_theme_config`,
            JSON.stringify(config),
            `Configuration for ${theme.display_name || theme.name} theme`
        ]);
        
        res.json({
            success: true,
            message: `Theme configuration updated for ${theme.name}`,
            theme: theme.name,
            config: config
        });
        
    } catch (error) {
        handleApiError(error, res);
    } finally {
        if (db) await db.end();
    }
});

/**
 * POST /api/universal-gallery/themes
 * Create new theme configuration
 */
router.post('/themes', async (req, res) => {
    let db;
    try {
        db = await getDbConnection();
        const { name, display_name, description, config } = req.body;
        
        if (!name || !config) {
            return res.status(400).json({
                error: 'Missing required fields',
                message: 'Theme name and configuration are required'
            });
        }
        
        // Check if theme already exists
        const [existingTheme] = await db.execute(
            'SELECT id FROM theme_sets WHERE name = ?',
            [name]
        );
        
        if (existingTheme.length > 0) {
            return res.status(409).json({
                error: 'Theme already exists',
                message: `Theme "${name}" already exists`
            });
        }
        
        // Validate configuration
        const validationResult = await validator.validateConfig(config);
        if (!validationResult.valid) {
            return res.status(400).json({
                error: 'Theme configuration validation failed',
                errors: validationResult.errors
            });
        }
        
        // Create theme entry
        const [themeResult] = await db.execute(`
            INSERT INTO theme_sets (name, display_name, description, category, pricing_tier, is_active, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())
        `, [
            name,
            display_name || name,
            description || `Custom theme: ${name}`,
            'custom',
            'free',
            1
        ]);
        
        // Save theme configuration
        await db.execute(`
            INSERT INTO universal_gallery_configs (config_name, config_json, description, created_at, updated_at)
            VALUES (?, ?, ?, NOW(), NOW())
        `, [
            `${name}_theme_config`,
            JSON.stringify(config),
            `Configuration for ${display_name || name} theme`
        ]);
        
        res.status(201).json({
            success: true,
            message: 'Theme created successfully',
            theme_id: themeResult.insertId,
            theme_name: name
        });
        
    } catch (error) {
        handleApiError(error, res);
    } finally {
        if (db) await db.end();
    }
});

// ===== Model Override Endpoints =====

/**
 * GET /api/universal-gallery/models
 * Get all models with their gallery configurations
 */
router.get('/models', async (req, res) => {
    let db;
    try {
        db = await getDbConnection();
        
        const { search, filter, page = 1, limit = 20 } = req.query;
        const offset = (page - 1) * limit;
        
        let whereClause = 'WHERE m.id IS NOT NULL';
        let queryParams = [];
        
        // Apply search filter
        if (search) {
            whereClause += ' AND (m.name LIKE ? OR m.slug LIKE ?)';
            queryParams.push(`%${search}%`, `%${search}%`);
        }
        
        // Apply status filter
        if (filter === 'with-overrides') {
            whereClause += ' AND mgpc.model_id IS NOT NULL';
        } else if (filter === 'using-defaults') {
            whereClause += ' AND mgpc.model_id IS NULL';
        }
        
        const [models] = await db.execute(`
            SELECT 
                m.id,
                m.name,
                m.slug,
                m.status,
                ts.name as theme_name,
                ts.display_name as theme_display_name,
                CASE WHEN mgpc.model_id IS NOT NULL THEN TRUE ELSE FALSE END as has_custom_config,
                mgpc.enable_lightbox,
                mgpc.show_captions,
                mgpc.default_layout
            FROM models m
            LEFT JOIN theme_sets ts ON m.theme_set_id = ts.id
            LEFT JOIN model_gallery_page_content mgpc ON m.id = mgpc.model_id
            ${whereClause}
            ORDER BY m.name
            LIMIT ? OFFSET ?
        `, [...queryParams, parseInt(limit), parseInt(offset)]);
        
        // Get total count
        const [countResult] = await db.execute(`
            SELECT COUNT(*) as total
            FROM models m
            LEFT JOIN model_gallery_page_content mgpc ON m.id = mgpc.model_id
            ${whereClause}
        `, queryParams);
        
        res.json({
            models: models,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: countResult[0].total,
                pages: Math.ceil(countResult[0].total / limit)
            }
        });
        
    } catch (error) {
        handleApiError(error, res);
    } finally {
        if (db) await db.end();
    }
});

/**
 * GET /api/universal-gallery/models/:modelId/config
 * Get model-specific gallery configuration
 */
router.get('/models/:modelId/config', async (req, res) => {
    let db;
    try {
        db = await getDbConnection();
        const { modelId } = req.params;
        
        // Get model info
        const [modelRows] = await db.execute(
            'SELECT * FROM models WHERE id = ?',
            [modelId]
        );
        
        if (modelRows.length === 0) {
            return res.status(404).json({
                error: 'Model not found',
                message: `Model with ID "${modelId}" does not exist`
            });
        }
        
        // Get model gallery configuration
        const [configRows] = await db.execute(
            'SELECT * FROM model_gallery_page_content WHERE model_id = ?',
            [modelId]
        );
        
        const model = modelRows[0];
        const config = configRows.length > 0 ? configRows[0] : null;
        
        res.json({
            model: model,
            config: config,
            has_custom_config: config !== null
        });
        
    } catch (error) {
        handleApiError(error, res);
    } finally {
        if (db) await db.end();
    }
});

/**
 * PUT /api/universal-gallery/models/:modelId/config
 * Update model-specific gallery configuration
 */
router.put('/models/:modelId/config', async (req, res) => {
    let db;
    try {
        db = await getDbConnection();
        const { modelId } = req.params;
        const config = req.body;
        
        // Check if model exists
        const [modelRows] = await db.execute(
            'SELECT * FROM models WHERE id = ?',
            [modelId]
        );
        
        if (modelRows.length === 0) {
            return res.status(404).json({
                error: 'Model not found',
                message: `Model with ID "${modelId}" does not exist`
            });
        }
        
        // Validate configuration
        const validationResult = await validator.validateConfig(config);
        if (!validationResult.valid) {
            return res.status(400).json({
                error: 'Model configuration validation failed',
                errors: validationResult.errors
            });
        }
        
        // Update or insert model gallery configuration
        const configFields = Object.keys(config);
        const configValues = Object.values(config);
        
        await db.execute(`
            INSERT INTO model_gallery_page_content (
                model_id, 
                ${configFields.join(', ')}, 
                updated_at
            )
            VALUES (?, ${configFields.map(() => '?').join(', ')}, NOW())
            ON DUPLICATE KEY UPDATE
                ${configFields.map(field => `${field} = VALUES(${field})`).join(', ')},
                updated_at = NOW()
        `, [modelId, ...configValues]);
        
        res.json({
            success: true,
            message: 'Model gallery configuration updated successfully',
            model_id: modelId,
            config: config
        });
        
    } catch (error) {
        handleApiError(error, res);
    } finally {
        if (db) await db.end();
    }
});

// ===== Statistics and Monitoring Endpoints =====

/**
 * GET /api/universal-gallery/stats
 * Get dashboard statistics
 */
router.get('/stats', async (req, res) => {
    try {
        // Return mock stats for now
        const stats = galleryService.getStats();
        res.json(stats);
        
    } catch (error) {
        handleApiError(error, res);
    }
});

/**
 * GET /api/universal-gallery/activity/recent
 * Get recent configuration changes
 */
router.get('/activity/recent', async (req, res) => {
    try {
        // Return mock recent activity for now
        const activities = [
            {
                type: 'config-update',
                title: 'System Configuration Updated',
                description: 'Updated default gallery layout to masonry',
                timestamp: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
                user: 'System Admin'
            },
            {
                type: 'theme-config',
                title: 'Template 5 Configuration Modified',
                description: 'Updated carousel settings for dark theme',
                timestamp: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
                user: 'Claude Admin'
            },
            {
                type: 'validation',
                title: 'Configuration Validation Complete',
                description: 'All 5 themes validated successfully',
                timestamp: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
                user: 'System'
            },
            {
                type: 'performance',
                title: 'Performance Audit Completed',
                description: 'Average load time: 1.2s across all galleries',
                timestamp: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
                user: 'System'
            }
        ];
        
        res.json(activities);
        
    } catch (error) {
        handleApiError(error, res);
    }
});

// ===== Configuration Validation Endpoints =====

/**
 * POST /api/universal-gallery/validate
 * Validate a configuration object
 */
router.post('/validate', async (req, res) => {
    try {
        const config = req.body;
        
        // Validate using our validation service
        const result = await validator.validateConfig(config);
        
        res.json({
            valid: result.valid,
            errors: result.errors || [],
            warnings: result.warnings || [],
            suggestions: result.suggestions || []
        });
        
    } catch (error) {
        handleApiError(error, res);
    }
});

/**
 * POST /api/universal-gallery/validate/all
 * Validate all configurations
 */
router.post('/validate/all', async (req, res) => {
    let db;
    try {
        db = await getDbConnection();
        
        const results = {
            system: { valid: true, errors: [] },
            themes: {},
            models: {}
        };
        
        // Validate system configuration
        const [systemConfig] = await db.execute(
            'SELECT setting_value FROM gallery_system_defaults WHERE setting_name = ?',
            ['default_gallery_config']
        );
        
        if (systemConfig.length > 0) {
            const config = JSON.parse(systemConfig[0].setting_value);
            results.system = await validator.validateConfig(config);
        }
        
        // Validate theme configurations
        const [themeConfigs] = await db.execute(`
            SELECT uc.config_name, uc.config_json, ts.name
            FROM universal_gallery_configs uc
            JOIN theme_sets ts ON uc.config_name = CONCAT(ts.name, '_theme_config')
            WHERE uc.is_active = TRUE
        `);
        
        for (const themeConfig of themeConfigs) {
            const config = JSON.parse(themeConfig.config_json);
            results.themes[themeConfig.name] = await validator.validateConfig(config);
        }
        
        res.json({
            success: true,
            results: results,
            summary: {
                total_validated: 1 + Object.keys(results.themes).length,
                valid_count: Object.values(results).filter(r => r.valid || Object.values(r).every(v => v.valid)).length,
                error_count: Object.values(results).reduce((sum, r) => 
                    sum + (r.errors ? r.errors.length : Object.values(r).reduce((s, v) => s + (v.errors || []).length, 0)), 0)
            }
        });
        
    } catch (error) {
        handleApiError(error, res);
    } finally {
        if (db) await db.end();
    }
});

// ===== Export/Import Endpoints =====

/**
 * GET /api/universal-gallery/export
 * Export all configurations
 */
router.get('/export', async (req, res) => {
    let db;
    try {
        db = await getDbConnection();
        
        // Export system configuration
        const [systemConfig] = await db.execute(
            'SELECT setting_value FROM gallery_system_defaults WHERE setting_name = ?',
            ['default_gallery_config']
        );
        
        // Export theme configurations
        const [themeConfigs] = await db.execute(
            'SELECT * FROM universal_gallery_configs WHERE is_active = TRUE'
        );
        
        // Export model configurations
        const [modelConfigs] = await db.execute(`
            SELECT m.id, m.name, m.slug, mgpc.*
            FROM models m
            JOIN model_gallery_page_content mgpc ON m.id = mgpc.model_id
        `);
        
        const exportData = {
            version: '1.0.0',
            exported_at: new Date().toISOString(),
            system: systemConfig.length > 0 ? JSON.parse(systemConfig[0].setting_value) : null,
            themes: themeConfigs.map(config => ({
                name: config.config_name,
                config: JSON.parse(config.config_json),
                description: config.description,
                version: config.version
            })),
            models: modelConfigs
        };
        
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="universal-gallery-config-${Date.now()}.json"`);
        res.json(exportData);
        
    } catch (error) {
        handleApiError(error, res);
    } finally {
        if (db) await db.end();
    }
});

module.exports = router;