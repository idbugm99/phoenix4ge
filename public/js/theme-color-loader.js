/**
 * ✨ THEME COLOR LOADER ✨
 * Client-side theme color injection from database
 */

class ThemeColorLoader {
    constructor() {
        this.currentThemeId = null;
        this.currentPaletteId = null;
        this.colorsLoaded = false;
    }

    /**
     * Initialize theme color loading
     * @param {number} themeId - Theme set ID
     * @param {number} paletteId - Palette ID (optional, uses theme default if null)
     * @param {boolean} isPreview - Whether this is a preview mode
     */
    async init(themeId, paletteId = null, isPreview = false) {
        this.currentThemeId = themeId;
        this.currentPaletteId = paletteId;
        
        console.log('🎨 ThemeColorLoader.init() called with:', { themeId, paletteId, isPreview });
        
        try {
            await this.loadThemeColors(themeId, paletteId);
            this.colorsLoaded = true;
            
            if (isPreview) {
                console.log(`🎨 Theme ${themeId} colors loaded in preview mode with palette ${paletteId || 'default'}`);
            }
        } catch (error) {
            console.error('Failed to load theme colors:', error);
        }
    }

    /**
     * Load theme colors from API and inject into DOM
     * @param {number} themeId - Theme set ID
     * @param {number} paletteId - Palette ID (optional)
     */
    async loadThemeColors(themeId, paletteId = null) {
        // Build URL with optional palette parameter
        let url = `/api/theme-colors/${themeId}/css`;
        if (paletteId) {
            url += `?paletteId=${paletteId}`;
        }
        
        console.log('🎨 Loading colors from:', url);
        
        const response = await fetch(url);
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const themeCSS = await response.text();
        
        console.log('🎨 Received CSS length:', themeCSS.length, 'characters');
        
        // Remove existing theme colors if any
        const existing = document.getElementById('database-theme-colors');
        if (existing) {
            console.log('🎨 Removing existing theme colors');
            existing.remove();
        }
        
        // Create style element with theme colors
        const styleElement = document.createElement('style');
        styleElement.id = 'database-theme-colors';
        styleElement.textContent = themeCSS;
        
        // Insert into head
        document.head.appendChild(styleElement);
        
        console.log('🎨 Theme colors injected successfully');
        
        // Trigger custom event for other components
        window.dispatchEvent(new CustomEvent('themeColorsLoaded', {
            detail: { themeId: themeId, paletteId: paletteId }
        }));
    }

    /**
     * Update a specific theme color
     * @param {string} variableName - CSS variable name
     * @param {string} variableValue - CSS variable value
     */
    async updateThemeColor(variableName, variableValue) {
        if (!this.currentThemeId) return;
        
        try {
            const response = await fetch(`/api/theme-colors/${this.currentThemeId}/${variableName}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ variableValue })
            });
            
            if (response.ok) {
                // Reload theme colors to reflect changes
                await this.loadThemeColors(this.currentThemeId, this.currentPaletteId);
                console.log(`✅ Updated ${variableName} to ${variableValue}`);
            }
        } catch (error) {
            console.error('Failed to update theme color:', error);
        }
    }

    /**
     * Get current theme colors data
     * @returns {Promise<Array>} Array of theme colors
     */
    async getThemeColors() {
        if (!this.currentThemeId) return [];
        
        try {
            const response = await fetch(`/api/theme-colors/${this.currentThemeId}`);
            const result = await response.json();
            return result.success ? result.data : [];
        } catch (error) {
            console.error('Failed to get theme colors:', error);
            return [];
        }
    }

    /**
     * Auto-detect theme and palette from URL parameters or body attributes
     */
    autoDetectTheme() {
        const urlParams = new URLSearchParams(window.location.search);
        const previewTheme = urlParams.get('preview_theme');
        const previewPalette = urlParams.get('preview_palette');
        
        console.log('🎨 URL params:', { previewTheme, previewPalette });
        
        if (previewTheme) {
            return {
                themeId: parseInt(previewTheme),
                paletteId: previewPalette ? parseInt(previewPalette) : null,
                isPreview: true
            };
        }
        
        // Get theme and palette from page data attributes
        const bodyThemeId = document.body.getAttribute('data-theme-id');
        const bodyPaletteId = document.body.getAttribute('data-palette-id');
        const bodyPreviewId = document.body.getAttribute('data-theme-preview');
        
        console.log('🎨 Body attributes:', { bodyThemeId, bodyPaletteId, bodyPreviewId });
        
        if (bodyPreviewId) {
            return {
                themeId: parseInt(bodyPreviewId),
                paletteId: bodyPaletteId ? parseInt(bodyPaletteId) : null,
                isPreview: true
            };
        }
        
        if (bodyThemeId && bodyThemeId !== '') {
            const config = {
                themeId: parseInt(bodyThemeId),
                paletteId: bodyPaletteId && bodyPaletteId !== 'null' && bodyPaletteId !== '' ? parseInt(bodyPaletteId) : null,
                isPreview: false
            };
            console.log('🎨 Auto-detected config:', config);
            return config;
        }
        
        // Default to theme 5 if no theme detected
        console.log('🎨 Using default theme 5');
        return {
            themeId: 5,
            paletteId: null,
            isPreview: true
        };
    }
}

// Auto-initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', async () => {
    console.log('🎨 DOM loaded, initializing ThemeColorLoader');
    const themeLoader = new ThemeColorLoader();
    const themeConfig = themeLoader.autoDetectTheme();
    
    if (themeConfig) {
        await themeLoader.init(themeConfig.themeId, themeConfig.paletteId, themeConfig.isPreview);
    }
    
    // Make available globally for debugging
    window.themeLoader = themeLoader;
});

// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ThemeColorLoader;
}
