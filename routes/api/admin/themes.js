const express = require('express');
const router = express.Router();
const { query } = require('../../../config/database');

// Get available themes (theme sets)
router.get('/', async (req, res) => {
    try {
        // Get all theme sets
        const themes = await query(`
            SELECT
                id,
                name,
                display_name,
                description,
                base_theme_id,
                is_active,
                preview_image,
                color_scheme
            FROM theme_sets
            WHERE is_active = 1
            ORDER BY display_name ASC
        `);

        // Get the current theme for the model if available
        const modelId = req.query.model_id || req.user?.modelId;
        let currentTheme = null;

        if (modelId) {
            const modelData = await query(`
                SELECT theme_set_id
                FROM models
                WHERE id = ?
            `, [modelId]);

            if (modelData.length > 0 && modelData[0].theme_set_id) {
                currentTheme = modelData[0].theme_set_id;
            }
        }

        res.json({
            success: true,
            themes: themes.map(theme => ({
                id: theme.id,
                name: theme.name,
                display_name: theme.display_name,
                description: theme.description,
                preview_image: theme.preview_image,
                colors: theme.color_scheme ? JSON.parse(theme.color_scheme) : {}
            })),
            current_theme: currentTheme
        });

    } catch (error) {
        console.error('Error fetching themes:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch themes',
            error: error.message
        });
    }
});

// Apply/activate a theme for a model
router.post('/:themeId/apply', async (req, res) => {
    try {
        const themeId = parseInt(req.params.themeId);

        // Get the model ID from the session or request
        const modelSlug = req.query.model_slug || req.body.model_slug;

        if (!modelSlug) {
            return res.status(400).json({
                success: false,
                message: 'Model slug is required'
            });
        }

        // Get model by slug
        const models = await query(`
            SELECT id, name, slug
            FROM models
            WHERE slug = ?
        `, [modelSlug]);

        if (models.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Model not found'
            });
        }

        const model = models[0];

        // Verify theme exists
        const themes = await query(`
            SELECT id, name, display_name
            FROM theme_sets
            WHERE id = ? AND is_active = 1
        `, [themeId]);

        if (themes.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Theme not found'
            });
        }

        const theme = themes[0];

        // Update model's theme_set_id AND reset active_color_palette_id to NULL
        // NULL means "use theme's default palette" - allows theme defaults to update dynamically
        await query(`
            UPDATE models
            SET theme_set_id = ?, active_color_palette_id = NULL
            WHERE id = ?
        `, [themeId, model.id]);

        console.log(`✅ Updated model ${model.id} to theme ${themeId}, reset to theme default (NULL)`);

        res.json({
            success: true,
            message: `Successfully switched to ${theme.display_name} theme`,
            theme: {
                id: theme.id,
                name: theme.name,
                display_name: theme.display_name
            },
            palette: {
                id: null,
                message: 'Using theme default colors'
            },
            model: {
                id: model.id,
                slug: model.slug
            }
        });

    } catch (error) {
        console.error('Error applying theme:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to apply theme',
            error: error.message
        });
    }
});

module.exports = router;
