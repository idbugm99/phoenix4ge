const express = require('express');
const router = express.Router();
const db = require('../../config/database');

// Helper function to normalize color tokens (same logic as loadColorPalette)
function normalizeColorTokens(rawTokens) {
    const colors = {};
    rawTokens.forEach(row => {
        colors[row.token_name] = row.token_value;
    });

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

    // Compose compatible colors used by legacy templates
    const compatibleColors = {
        primary: std.primary,
        secondary: std.secondary,
        text: std.text,
        background: std.bg,
        accent: std.accent
    };

    // Return full color object with both token-based and compatible colors
    return { ...normalized, ...std, ...compatibleColors };
}

/**
 * GET /api/color-palettes/:paletteId
 * Get color palette by ID with full normalization (replacement for loadColorPalette)
 */
router.get('/:paletteId', async (req, res) => {
    try {
        const paletteId = parseInt(req.params.paletteId);
        
        if (!paletteId || isNaN(paletteId)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid palette ID'
            });
        }

        // Get palette info
        const paletteInfo = await db.query(`
            SELECT id, name, display_name, theme_set_id, is_system_palette
            FROM color_palettes 
            WHERE id = ?
        `, [paletteId]);

        if (!paletteInfo.length) {
            return res.status(404).json({
                success: false,
                message: 'Color palette not found'
            });
        }

        // Get all color tokens for the palette
        const colorTokens = await db.query(`
            SELECT token_name, token_value, token_description
            FROM color_palette_values
            WHERE palette_id = ?
        `, [paletteId]);

        if (colorTokens.length === 0) {
            // Return fallback colors if no tokens found
            const fallbackColors = normalizeColorTokens([]);
            return res.status(200).json({
                success: true,
                data: {
                    palette_id: paletteId,
                    palette_info: paletteInfo[0],
                    colors: fallbackColors,
                    raw_tokens: [],
                    token_count: 0,
                    is_fallback: true
                }
            });
        }

        // Normalize colors using the same logic as loadColorPalette
        const normalizedColors = normalizeColorTokens(colorTokens);

        return res.status(200).json({
            success: true,
            data: {
                palette_id: paletteId,
                palette_info: paletteInfo[0],
                colors: normalizedColors,
                raw_tokens: colorTokens,
                token_count: colorTokens.length,
                is_fallback: false
            }
        });

    } catch (error) {
        console.error('Error loading color palette:', error);
        return res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

/**
 * GET /api/color-palettes/by-theme/:themeId
 * Get default color palette for a theme (replacement for theme default palette lookup)
 */
router.get('/by-theme/:themeId', async (req, res) => {
    try {
        const themeId = parseInt(req.params.themeId);
        
        if (!themeId || isNaN(themeId)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid theme ID'
            });
        }

        // Get theme's default palette ID
        const themeInfo = await db.query(`
            SELECT id, name, display_name, default_palette_id
            FROM theme_sets 
            WHERE id = ?
        `, [themeId]);

        if (!themeInfo.length) {
            return res.status(404).json({
                success: false,
                message: 'Theme not found'
            });
        }

        const theme = themeInfo[0];
        
        if (!theme.default_palette_id) {
            // Return fallback colors if theme has no default palette
            const fallbackColors = normalizeColorTokens([]);
            return res.status(200).json({
                success: true,
                data: {
                    theme_id: themeId,
                    theme_info: theme,
                    palette_id: null,
                    colors: fallbackColors,
                    raw_tokens: [],
                    token_count: 0,
                    is_fallback: true
                }
            });
        }

        // Get palette info and colors
        const paletteInfo = await db.query(`
            SELECT id, name, display_name, is_system_palette
            FROM color_palettes 
            WHERE id = ?
        `, [theme.default_palette_id]);

        const colorTokens = await db.query(`
            SELECT token_name, token_value, token_description
            FROM color_palette_values
            WHERE palette_id = ?
        `, [theme.default_palette_id]);

        // Normalize colors using the same logic as loadColorPalette
        const normalizedColors = normalizeColorTokens(colorTokens);

        return res.status(200).json({
            success: true,
            data: {
                theme_id: themeId,
                theme_info: theme,
                palette_id: theme.default_palette_id,
                palette_info: paletteInfo[0] || null,
                colors: normalizedColors,
                raw_tokens: colorTokens,
                token_count: colorTokens.length,
                is_fallback: colorTokens.length === 0
            }
        });

    } catch (error) {
        console.error('Error loading theme default palette:', error);
        return res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
});

/**
 * GET /api/models/:id/colors
 * Get model's current color scheme with theme and palette information
 */
router.get('/models/:id/colors', async (req, res) => {
    try {
        const modelId = req.params.id;
        
        // Get model's current theme and active color palette
        const modelData = await db.query(`
            SELECT 
                m.id, 
                m.name, 
                m.slug,
                m.theme_set_id,
                m.active_color_palette_id,
                ts.name as theme_name,
                ts.display_name as theme_display_name,
                cp.name as palette_name,
                cp.display_name as palette_display_name,
                cp.is_system_palette,
                cp.created_by_model_id
            FROM models m
            JOIN theme_sets ts ON m.theme_set_id = ts.id
            LEFT JOIN color_palettes cp ON m.active_color_palette_id = cp.id
            WHERE m.id = ?
        `, [modelId]);

        if (!modelData.length) {
            return res.status(404).json({ error: 'Model not found' });
        }

        const model = modelData[0];

        // Determine which palette to use:
        // - If active_color_palette_id is NULL → use theme's default palette
        // - Otherwise → use the specific custom palette
        let paletteId = model.active_color_palette_id;
        let paletteSource = 'custom';

        if (!paletteId) {
            // NULL means use theme default - get theme's default_palette_id
            const themeInfo = await db.query(`
                SELECT default_palette_id
                FROM theme_sets
                WHERE id = ?
            `, [model.theme_set_id]);

            paletteId = themeInfo[0]?.default_palette_id;
            paletteSource = 'theme_default';
            console.log(`🎨 Model ${model.id} has NULL palette, using theme ${model.theme_set_id} default palette ${paletteId}`);
        }

        // Get all color tokens for the determined palette
        const colorTokens = await db.query(`
            SELECT token_name, token_value, token_description
            FROM color_palette_values
            WHERE palette_id = ?
            ORDER BY token_name
        `, [paletteId]);

        // Convert to key-value object for easier template usage
        const colors = {};
        colorTokens.forEach(token => {
            colors[token.token_name] = token.token_value;
        });

        // Determine if this is a custom palette
        const isCustom = model.created_by_model_id === parseInt(modelId);

        res.json({
            theme: {
                id: model.theme_set_id,
                name: model.theme_name,
                display_name: model.theme_display_name
            },
            palette: {
                id: paletteId,
                name: model.palette_name,
                display_name: model.palette_display_name,
                is_custom: isCustom,
                source: paletteSource  // 'theme_default' or 'custom'
            },
            colors: colors,
            token_count: colorTokens.length
        });

    } catch (error) {
        console.error('Error fetching model colors:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * GET /api/models/:id/palettes
 * Get all available palettes for a model (system palettes + their custom ones)
 */
router.get('/models/:id/palettes', async (req, res) => {
    try {
        const modelId = req.params.id;

        // Get all system palettes + model's custom palettes
        const palettes = await db.query(`
            SELECT 
                id,
                name,
                display_name,
                description,
                is_system_palette,
                created_by_model_id,
                theme_set_id,
                created_at
            FROM color_palettes
            WHERE is_system_palette = 1 
               OR created_by_model_id = ?
            ORDER BY 
                is_system_palette DESC,
                created_at DESC
        `, [modelId]);

        // Get preview colors for each palette (first 6 standard tokens for UI preview)
        const palettesWithColors = await Promise.all(palettes.map(async (palette) => {
            const previewColors = await db.query(`
                SELECT token_name, token_value
                FROM color_palette_values
                WHERE palette_id = ?
                  AND token_name IN ('primary', 'secondary', 'accent', 'background', 'text', 'success')
                ORDER BY
                    CASE token_name
                        WHEN 'primary' THEN 1
                        WHEN 'secondary' THEN 2
                        WHEN 'accent' THEN 3
                        WHEN 'background' THEN 4
                        WHEN 'text' THEN 5
                        WHEN 'success' THEN 6
                    END
            `, [palette.id]);

            const colors = {};
            previewColors.forEach(token => {
                colors[token.token_name] = token.token_value;
            });

            return {
                ...palette,
                preview_colors: colors,
                is_custom: palette.created_by_model_id === parseInt(modelId)
            };
        }));

        res.json({
            palettes: palettesWithColors
        });

    } catch (error) {
        console.error('Error fetching model palettes:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * PUT /api/models/:id/palette
 * Update model's active palette
 */
router.put('/models/:id/palette', async (req, res) => {
    try {
        const modelId = req.params.id;
        const { palette_id } = req.body;

        if (!palette_id) {
            return res.status(400).json({ error: 'palette_id is required' });
        }

        // Verify palette exists and model has access to it
        const paletteCheck = await db.query(`
            SELECT id, is_system_palette, created_by_model_id
            FROM color_palettes
            WHERE id = ?
              AND (is_system_palette = 1 OR created_by_model_id = ?)
        `, [palette_id, modelId]);

        if (!paletteCheck.length) {
            return res.status(404).json({ error: 'Palette not found or access denied' });
        }

        // Update model's active palette
        await db.query(`
            UPDATE models 
            SET active_color_palette_id = ?
            WHERE id = ?
        `, [palette_id, modelId]);

        res.json({
            success: true,
            message: 'Active palette updated successfully',
            palette_id: parseInt(palette_id)
        });

    } catch (error) {
        console.error('Error updating model palette:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * POST /api/models/:id/palettes/custom
 * Create custom palette from edits
 */
router.post('/models/:id/palettes/custom', async (req, res) => {
    try {
        const modelId = req.params.id;
        const { name, color_edits } = req.body;

        if (!name || !color_edits || typeof color_edits !== 'object') {
            return res.status(400).json({
                error: 'name and color_edits object are required'
            });
        }

        // Get model's current theme info
        const modelData = await db.query(`
            SELECT
                m.theme_set_id,
                m.slug,
                ts.default_palette_id
            FROM models m
            LEFT JOIN theme_sets ts ON m.theme_set_id = ts.id
            WHERE m.id = ?
        `, [modelId]);

        if (!modelData.length) {
            return res.status(404).json({ error: 'Model not found' });
        }

        const model = modelData[0];

        // Create new STANDALONE custom palette (theme_set_id = NULL makes it reusable across themes)
        const customPaletteName = name.toLowerCase().replace(/\s+/g, '-');
        const paletteResult = await db.query(`
            INSERT INTO color_palettes (
                name,
                display_name,
                description,
                is_system_palette,
                created_by_model_id,
                theme_set_id,
                created_at,
                updated_at
            ) VALUES (?, ?, ?, 0, ?, NULL, NOW(), NOW())
        `, [
            customPaletteName,
            name,
            `Custom palette created by ${model.slug}`,
            modelId
        ]);

        const newPaletteId = paletteResult.insertId;

        // Clone all tokens from the theme's default palette to ensure we have all 33 tokens
        const defaultPaletteId = model.default_palette_id || 17; // Royal Gem default
        const defaultTokens = await db.query(`
            SELECT token_name, token_value, token_description
            FROM color_palette_values
            WHERE palette_id = ?
        `, [defaultPaletteId]);

        // Insert all tokens with user's edits applied
        const tokenInserts = defaultTokens.map(token => {
            const editedValue = color_edits[token.token_name] || token.token_value;
            return [
                newPaletteId,
                token.token_name,
                editedValue,
                token.token_description
            ];
        });

        if (tokenInserts.length > 0) {
            await db.query(`
                INSERT INTO color_palette_values (palette_id, token_name, token_value, token_description)
                VALUES ${tokenInserts.map(() => '(?, ?, ?, ?)').join(', ')}
            `, tokenInserts.flat());
        }

        console.log(`✅ Created custom palette ${newPaletteId} (${name}) for model ${modelId} with ${tokenInserts.length} tokens`);

        res.json({
            success: true,
            message: 'Custom palette created successfully',
            palette: {
                id: newPaletteId,
                name: customPaletteName,
                display_name: name,
                is_custom: true,
                token_count: tokenInserts.length
            }
        });

    } catch (error) {
        console.error('Error creating custom palette:', error);
        res.status(500).json({ error: 'Internal server error', message: error.message });
    }
});

/**
 * PUT /api/palettes/:id/colors
 * Update custom palette colors (only for palettes created by current model)
 */
router.put('/palettes/:id/colors', async (req, res) => {
    try {
        const paletteId = req.params.id;
        const colorUpdates = req.body;

        if (!colorUpdates || typeof colorUpdates !== 'object') {
            return res.status(400).json({
                error: 'Color updates object is required'
            });
        }

        // Verify this is a custom palette (not system palette)
        const paletteCheck = await db.query(`
            SELECT id, is_system_palette, created_by_model_id
            FROM color_palettes
            WHERE id = ? AND is_system_palette = 0
        `, [paletteId]);

        if (!paletteCheck.length) {
            return res.status(404).json({
                error: 'Custom palette not found or cannot modify system palette'
            });
        }

        // Update/insert each color token (UPSERT)
        const updates = Object.entries(colorUpdates);
        if (updates.length === 0) {
            return res.status(400).json({ error: 'No color updates provided' });
        }

        for (const [tokenName, tokenValue] of updates) {
            // Use INSERT ... ON DUPLICATE KEY UPDATE to handle both new and existing tokens
            await db.query(`
                INSERT INTO color_palette_values (palette_id, token_name, token_value, updated_at)
                VALUES (?, ?, ?, NOW())
                ON DUPLICATE KEY UPDATE
                    token_value = VALUES(token_value),
                    updated_at = NOW()
            `, [paletteId, tokenName, tokenValue]);
        }

        // Update palette modified timestamp
        await db.query(`
            UPDATE color_palettes
            SET updated_at = NOW()
            WHERE id = ?
        `, [paletteId]);

        console.log(`✅ Updated ${updates.length} tokens for palette ${paletteId}`);

        res.json({
            success: true,
            message: 'Palette colors updated successfully',
            updated_tokens: updates.length
        });

    } catch (error) {
        console.error('Error updating palette colors:', error);
        res.status(500).json({ error: 'Internal server error', message: error.message });
    }
});

/**
 * DELETE /api/color-palettes/palettes/:id
 * Delete a custom palette (only if created by a model, not system palettes)
 */
router.delete('/palettes/:id', async (req, res) => {
    try {
        const paletteId = parseInt(req.params.id);

        if (!paletteId || isNaN(paletteId)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid palette ID'
            });
        }

        // Verify this is a custom palette (not system palette)
        const paletteCheck = await db.query(`
            SELECT id, name, display_name, is_system_palette, created_by_model_id
            FROM color_palettes
            WHERE id = ? AND is_system_palette = 0
        `, [paletteId]);

        if (!paletteCheck.length) {
            return res.status(404).json({
                success: false,
                error: 'Custom palette not found or cannot delete system palette'
            });
        }

        const palette = paletteCheck[0];

        // Delete all color tokens first (foreign key constraint)
        await db.query(`
            DELETE FROM color_palette_values
            WHERE palette_id = ?
        `, [paletteId]);

        // Delete the palette
        await db.query(`
            DELETE FROM color_palettes
            WHERE id = ?
        `, [paletteId]);

        // Check if any models are using this palette and reset them to NULL
        await db.query(`
            UPDATE models
            SET active_color_palette_id = NULL
            WHERE active_color_palette_id = ?
        `, [paletteId]);

        console.log(`✅ Deleted custom palette ${paletteId} (${palette.display_name}) and reset any models using it`);

        res.json({
            success: true,
            message: `Palette "${palette.display_name}" deleted successfully`
        });

    } catch (error) {
        console.error('Error deleting palette:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error',
            message: error.message
        });
    }
});

module.exports = router;