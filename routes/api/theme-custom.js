const express = require('express');
const router = express.Router();
const { query } = require('../../config/database');

// Get theme templates (theme sets with their pages)
router.get('/templates', async (req, res) => {
    try {
        // Get all theme sets with their page configurations
        const themes = await query(`
            SELECT
                ts.id,
                ts.name,
                ts.display_name,
                ts.description,
                ts.color_scheme,
                ts.preview_image,
                GROUP_CONCAT(
                    CONCAT(pt.name, ':', tsp.template_file)
                    SEPARATOR ','
                ) as pages
            FROM theme_sets ts
            LEFT JOIN theme_set_pages tsp ON ts.id = tsp.theme_set_id
            LEFT JOIN page_types pt ON tsp.page_type_id = pt.id
            WHERE ts.is_active = 1
            GROUP BY ts.id
            ORDER BY ts.display_name ASC
        `);

        const templates = themes.map(theme => {
            let colorVariables = {};
            try {
                if (theme.color_scheme) {
                    colorVariables = JSON.parse(theme.color_scheme);
                }
            } catch (e) {
                console.error('Error parsing color_scheme for theme', theme.id);
            }

            return {
                id: theme.id,
                name: theme.name,
                display_name: theme.display_name,
                description: theme.description,
                color_variables: colorVariables,
                preview_image: theme.preview_image,
                pages: theme.pages ? theme.pages.split(',').reduce((acc, page) => {
                    const [pageName, templateFile] = page.split(':');
                    acc[pageName] = templateFile;
                    return acc;
                }, {}) : {}
            };
        });

        res.json({
            success: true,
            templates
        });

    } catch (error) {
        console.error('Error fetching theme templates:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch theme templates',
            error: error.message
        });
    }
});

module.exports = router;
