/**
 * phoenix4ge Admin Dashboard - Theme Management
 */
if (window.ComponentRegistryClient) {
    window.ComponentRegistryClient.register('admin-themes', 'admin/js/themes.js');
}

class ThemesManager {
    constructor() {
        this.themes = [];
        this.templates = [];
        this.currentTheme = 'basic';
        this.currentTemplate = null;
        this.customColors = {};
        
        this.init();
    }

    init() {
        this.setupEventListeners();
    }

    setupEventListeners() {
        // Color customization button
        const customizeColorsBtn = document.getElementById('customizeColorsBtn');
        if (customizeColorsBtn) {
            customizeColorsBtn.addEventListener('click', () => this.showColorCustomModal());
        }

        // Modal close buttons
        document.addEventListener('click', (e) => {
            if (e.target.matches('[data-close-modal]')) {
                this.closeModals();
            }
        });

        // Color customization buttons
        const saveColorsBtn = document.getElementById('saveColorsBtn');
        const resetColorsBtn = document.getElementById('resetColorsBtn');
        
        if (saveColorsBtn) {
            saveColorsBtn.addEventListener('click', () => this.saveCustomColors());
        }
        
        if (resetColorsBtn) {
            resetColorsBtn.addEventListener('click', () => this.resetToDefaults());
        }
    }

    async loadThemes() {
        try {
            console.log('Loading themes...');
            showLoading(true);
            
            // Check if adminDashboard is available
            if (!window.adminDashboard) {
                console.error('AdminDashboard not available');
                showNotification('Dashboard not ready', 'error');
                return;
            }
            
            console.log('Loading themes and templates...');
            
            // Get both themes and theme templates
            const [themesResponse, templatesResponse] = await Promise.all([
                window.adminDashboard.apiRequest('/api/admin/themes'),
                window.adminDashboard.apiRequest('/api/theme-custom/templates')
            ]);
            console.log('Themes API response:', themesResponse);
            console.log('Templates API response:', templatesResponse);
            
            if (themesResponse.themes && templatesResponse.templates) {
                // Store both themes and templates
                this.themes = themesResponse.themes.map(theme => ({
                    id: theme.id,
                    name: theme.display_name,
                    slug: theme.name,
                    description: theme.description || `${theme.display_name} theme`,
                    preview: `/admin/previews/${theme.name}-preview.jpg`,
                    color: theme.colors?.primary || '#3B82F6',
                    colors: theme.colors || {}
                }));
                
                this.templates = templatesResponse.templates.map(template => ({
                    id: template.id,
                    name: template.name,
                    displayName: template.display_name,
                    description: template.description,
                    colorVariables: template.color_variables,
                    previewImage: template.preview_image
                }));
                
                this.currentTheme = themesResponse.current_theme || 'basic';
                console.log('Loaded themes:', this.themes.length, 'Templates:', this.templates.length, 'Current:', this.currentTheme);
            } else {
                console.error('Failed to load themes or templates');
                showNotification('Failed to load themes', 'error');
            }
        } catch (error) {
            console.error('Error loading themes:', error);
            showNotification(`Error loading themes: ${error.message}`, 'error');
        } finally {
            showLoading(false);
        }
        
        this.renderThemes();
        this.renderTemplates();
    }

    renderThemes() {
        const container = document.getElementById('themesGrid');
        if (!container) return;

        if (this.themes.length === 0) {
            container.innerHTML = `
                <div class="col-span-full text-center py-8 text-gray-500">
                    <i class="fas fa-palette text-3xl mb-2"></i>
                    <p>Loading themes...</p>
                </div>
            `;
            return;
        }

        container.innerHTML = this.themes.map(theme => `
            <div class="theme-card bg-white rounded-lg shadow-sm border-2 ${theme.slug === this.currentTheme ? 'border-blue-500' : 'border-gray-200'} overflow-hidden hover:shadow-lg transition-all">
                <div class="aspect-w-16 aspect-h-10 bg-gray-100">
                    <div class="w-full h-48 bg-gradient-to-br from-gray-100 to-gray-200 flex items-center justify-center" style="background: linear-gradient(135deg, ${theme.color}20, ${theme.color}10)">
                        <div class="text-center">
                            <div class="w-16 h-16 mx-auto mb-2 rounded-lg" style="background-color: ${theme.color}"></div>
                            <div class="w-20 h-2 bg-gray-300 rounded mx-auto mb-1"></div>
                            <div class="w-16 h-2 bg-gray-200 rounded mx-auto"></div>
                        </div>
                    </div>
                </div>
                
                <div class="p-6">
                    <div class="flex items-center justify-between mb-2">
                        <h3 class="text-lg font-semibold text-gray-900">${theme.name}</h3>
                        ${theme.slug === this.currentTheme ? `
                            <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                                <i class="fas fa-check mr-1"></i>
                                Current Theme
                            </span>
                        ` : ''}
                    </div>
                    
                    <p class="text-sm text-gray-600 mb-4">${theme.description}</p>
                    
                    <div class="flex space-x-2">
                        ${theme.slug === this.currentTheme ? `
                            <button class="flex-1 px-4 py-2 bg-gray-100 text-gray-500 rounded-lg cursor-not-allowed">
                                Current Theme
                            </button>
                        ` : `
                            <button onclick="themesManager.switchTheme(${theme.id})" class="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors">
                                Activate Theme
                            </button>
                        `}
                        <button onclick="themesManager.previewTheme(${theme.id})" class="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors">
                            <i class="fas fa-eye"></i>
                        </button>
                    </div>
                </div>
            </div>
        `).join('');
    }

    renderTemplates() {
        const container = document.getElementById('templatesGrid');
        if (!container || !this.templates) return;

        if (this.templates.length === 0) {
            container.innerHTML = `
                <div class="col-span-full text-center py-8 text-gray-500">
                    <i class="fas fa-palette text-3xl mb-2"></i>
                    <p>Loading templates...</p>
                </div>
            `;
            return;
        }

        container.innerHTML = this.templates.map(template => `
            <div class="template-card bg-white rounded-lg shadow-sm border-2 ${this.currentTemplate === template.name ? 'border-purple-500' : 'border-gray-200'} overflow-hidden hover:shadow-lg transition-all cursor-pointer"
                 onclick="themesManager.selectTemplate('${template.name}')">
                
                <!-- Template Preview -->
                <div class="h-32 bg-gradient-to-br from-gray-100 to-gray-200 flex items-center justify-center p-4">
                    <div class="text-center">
                        <div class="w-12 h-12 mx-auto mb-2 rounded-lg bg-gradient-to-br" 
                             style="background: linear-gradient(135deg, ${template.colorVariables.primary || '#3B82F6'}, ${template.colorVariables.secondary || '#6B7280'})"></div>
                        <div class="text-xs text-gray-600">${template.displayName}</div>
                    </div>
                </div>
                
                <!-- Template Info -->
                <div class="p-4">
                    <div class="flex items-center justify-between mb-2">
                        <h3 class="font-semibold text-gray-900">${template.displayName}</h3>
                        ${this.currentTemplate === template.name ? `
                            <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-800">
                                <i class="fas fa-check mr-1"></i>
                                Active
                            </span>
                        ` : ''}
                    </div>
                    
                    <p class="text-sm text-gray-600 mb-3">${template.description}</p>
                    
                    <div class="flex justify-between items-center">
                        <div class="flex space-x-1">
                            ${Object.entries(template.colorVariables).slice(0, 3).map(([key, color]) => `
                                <div class="w-4 h-4 rounded-full border border-gray-300" 
                                     style="background-color: ${color}" 
                                     title="${key}"></div>
                            `).join('')}
                        </div>
                        
                        <button onclick="event.stopPropagation(); themesManager.applyTemplate('${template.name}')" 
                                class="text-sm px-3 py-1 ${this.currentTemplate === template.name ? 'bg-gray-100 text-gray-500' : 'bg-purple-600 text-white hover:bg-purple-700'} rounded transition-colors">
                            ${this.currentTemplate === template.name ? 'Current' : 'Apply'}
                        </button>
                    </div>
                </div>
            </div>
        `).join('');
    }

    async selectTemplate(templateName) {
        const template = this.templates.find(t => t.name === templateName);
        if (!template) return;

        this.currentTemplate = templateName;
        this.renderTemplates();
        
        // Load current colors for this template
        await this.loadCurrentThemeColors();
    }

    async applyTemplate(templateName) {
        const template = this.templates.find(t => t.name === templateName);
        if (!template) return;

        try {
            showLoading(true);
            
            // Apply template with default colors
            const response = await window.adminDashboard.apiRequest('/api/theme-custom/apply', {
                method: 'POST',
                body: JSON.stringify({
                    themeId: this.getCurrentThemeId(templateName),
                    customColors: template.colorVariables
                })
            });

            if (response.success) {
                this.currentTemplate = templateName;
                showNotification(`Applied ${template.displayName} template successfully`, 'success');
                this.renderTemplates();
                
                // Refresh dashboard stats
                if (window.adminDashboard && window.adminDashboard.loadDashboardData) {
                    window.adminDashboard.loadDashboardData();
                }
            } else {
                showNotification('Failed to apply template', 'error');
            }
        } catch (error) {
            console.error('Error applying template:', error);
            showNotification('Error applying template', 'error');
        } finally {
            showLoading(false);
        }
    }

    getCurrentThemeId(templateName) {
        // Find or create theme ID for this template
        const theme = this.themes.find(t => t.slug === templateName);
        return theme ? theme.id : 1; // Default to basic theme ID
    }

    async showColorCustomModal() {
        await this.loadCurrentThemeColors();
        this.renderColorControls();
        
        const modal = document.getElementById('colorCustomModal');
        if (modal) {
            modal.classList.remove('hidden');
        }
    }

    async loadCurrentThemeColors() {
        try {
            const response = await window.adminDashboard.apiRequest('/api/theme-custom/current');
            
            if (response.success && response.theme) {
                this.currentTheme = response.theme.name;
                this.customColors = { ...response.theme.color_variables, ...response.customColors };
                this.currentTemplate = response.theme.name;
            }
        } catch (error) {
            console.error('Error loading current theme colors:', error);
        }
    }

    renderColorControls() {
        const container = document.getElementById('colorControls');
        if (!container) return;

        const template = this.templates.find(t => t.name === this.currentTemplate);
        if (!template) return;

        const colorTypes = Object.keys(template.colorVariables);
        
        container.innerHTML = colorTypes.map(colorType => {
            const currentColor = this.customColors[colorType] || template.colorVariables[colorType];
            
            return `
                <div class="flex items-center space-x-3">
                    <label class="block text-sm font-medium text-gray-700 w-20 capitalize">
                        ${colorType}
                    </label>
                    <input type="color" 
                           id="color-${colorType}" 
                           value="${currentColor}"
                           onchange="themesManager.updateColorPreview('${colorType}', this.value)"
                           class="h-10 w-16 border border-gray-300 rounded cursor-pointer">
                    <span class="text-sm text-gray-500 font-mono">${currentColor}</span>
                </div>
            `;
        }).join('');
    }

    updateColorPreview(colorType, colorValue) {
        // Update preview CSS variables
        const preview = document.getElementById('colorPreview');
        if (preview) {
            preview.style.setProperty(`--preview-${colorType}`, colorValue);
        }
        
        // Update the stored colors
        this.customColors[colorType] = colorValue;
        
        // Update the color code display
        const colorInput = document.getElementById(`color-${colorType}`);
        if (colorInput) {
            const codeSpan = colorInput.nextElementSibling;
            if (codeSpan) {
                codeSpan.textContent = colorValue;
            }
        }
    }

    async saveCustomColors() {
        if (!this.currentTemplate) {
            showNotification('Please select a template first', 'error');
            return;
        }

        try {
            showLoading(true);
            
            const themeId = this.getCurrentThemeId(this.currentTemplate);
            const response = await window.adminDashboard.apiRequest('/api/theme-custom/colors', {
                method: 'POST',
                body: JSON.stringify({
                    themeId: themeId,
                    colors: this.customColors
                })
            });

            if (response.success) {
                showNotification('Colors saved successfully', 'success');
                this.closeModals();
                
                // Apply the updated theme
                await this.applyTemplate(this.currentTemplate);
            } else {
                showNotification('Failed to save colors', 'error');
            }
        } catch (error) {
            console.error('Error saving colors:', error);
            showNotification('Error saving colors', 'error');
        } finally {
            showLoading(false);
        }
    }

    async resetToDefaults() {
        if (!this.currentTemplate) return;

        try {
            showLoading(true);
            
            const themeId = this.getCurrentThemeId(this.currentTemplate);
            const response = await window.adminDashboard.apiRequest(`/api/theme-custom/colors/${themeId}`, {
                method: 'DELETE'
            });

            if (response.success) {
                // Reset to template defaults
                const template = this.templates.find(t => t.name === this.currentTemplate);
                if (template) {
                    this.customColors = { ...template.colorVariables };
                    this.renderColorControls();
                    this.updateAllColorPreviews();
                }
                
                showNotification('Colors reset to defaults', 'success');
            } else {
                showNotification('Failed to reset colors', 'error');
            }
        } catch (error) {
            console.error('Error resetting colors:', error);
            showNotification('Error resetting colors', 'error');
        } finally {
            showLoading(false);
        }
    }

    updateAllColorPreviews() {
        Object.entries(this.customColors).forEach(([colorType, colorValue]) => {
            this.updateColorPreview(colorType, colorValue);
        });
    }

    closeModals() {
        const modals = document.querySelectorAll('.modal');
        modals.forEach(modal => modal.classList.add('hidden'));
    }

    async switchTheme(themeId) {
        const theme = this.themes.find(t => t.id === themeId);
        if (!theme) return;

        if (!confirm(`Switch to ${theme.name} theme? This will change your site's appearance immediately.`)) {
            return;
        }

        try {
            showLoading(true);

            const modelSlug = window.adminDashboard?.currentUser?.slug || window.location.pathname.split('/')[1];

            const response = await window.adminDashboard.apiRequest(`/api/admin/themes/${themeId}/apply?model_slug=${modelSlug}`, {
                method: 'POST'
            });

            if (response.message && response.theme) {
                // Update current theme to the theme slug/name for comparison
                this.currentTheme = theme.slug;
                showNotification(`Successfully switched to ${response.theme.display_name} theme`, 'success');
                this.renderThemes();
                
                // Update dashboard stats if element exists
                const currentThemeElement = document.getElementById('currentTheme');
                if (currentThemeElement) {
                    currentThemeElement.textContent = response.theme.display_name;
                }
                
                // Refresh stats to get updated theme
                if (window.adminDashboard && window.adminDashboard.loadStats) {
                    window.adminDashboard.loadStats();
                }
            } else {
                showNotification('Failed to switch theme', 'error');
            }
        } catch (error) {
            console.error('Error switching theme:', error);
            showNotification('Failed to switch theme', 'error');
        } finally {
            showLoading(false);
        }
    }

    previewTheme(themeId) {
        const theme = this.themes.find(t => t.id === themeId);
        if (!theme || !window.adminDashboard.currentUser) return;

        // Open preview in new window
        const previewUrl = `${window.location.origin}/${window.adminDashboard.currentUser.slug}/?preview_theme=${themeId}`;
        window.open(previewUrl, '_blank', 'width=1200,height=800');
    }
}

// Initialize themes manager when admin dashboard is ready
window.addEventListener('adminDashboardReady', () => {
    console.log('Admin dashboard ready, initializing themes manager');
    window.themesManager = new ThemesManager();
});

// Fallback initialization in case the event was already fired
document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
        if (!window.themesManager && window.adminDashboard) {
            console.log('Fallback themes manager initialization');
            window.themesManager = new ThemesManager();
        }
    }, 1000);
});