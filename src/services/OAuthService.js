const { query } = require('../../config/database');
const crypto = require('crypto');

/**
 * OAuthService - OAuth/Social Login management
 *
 * Features:
 * - OAuth provider management (Google, Facebook, Apple)
 * - Account linking (link OAuth to existing account)
 * - Account creation via OAuth (signup)
 * - State token generation for CSRF protection
 * - Token storage and refresh
 */
class OAuthService {
    /**
     * Generate OAuth state token for CSRF protection
     * @param {string} provider - OAuth provider (google, facebook, apple)
     * @param {string} action - Action type (login, signup, link)
     * @param {number|null} userId - User ID (for linking)
     * @param {string} ipAddress - IP address
     * @param {string} userAgent - User agent
     * @param {string|null} returnUrl - URL to return to after OAuth
     * @returns {Promise<string>} State token
     */
    async generateStateToken(provider, action, userId, ipAddress, userAgent, returnUrl = null) {
        const stateToken = crypto.randomBytes(32).toString('hex');

        await query(`
            INSERT INTO oauth_state_tokens (
                state_token, provider, action, user_id,
                ip_address, user_agent, return_url,
                expires_at, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE), NOW())
        `, [stateToken, provider, action, userId, ipAddress, userAgent, returnUrl]);

        console.log(`🔐 Generated OAuth state token for ${provider} ${action}`);
        return stateToken;
    }

    /**
     * Verify and consume OAuth state token
     * @param {string} stateToken - State token
     * @returns {Promise<Object|null>} State data or null if invalid
     */
    async verifyStateToken(stateToken) {
        const states = await query(`
            SELECT id, provider, action, user_id, return_url, expires_at, used
            FROM oauth_state_tokens
            WHERE state_token = ?
        `, [stateToken]);

        if (states.length === 0) {
            return null;
        }

        const state = states[0];

        // Check if already used
        if (state.used) {
            return null;
        }

        // Check expiry
        if (new Date(state.expires_at) < new Date()) {
            return null;
        }

        // Mark as used
        await query(`
            UPDATE oauth_state_tokens
            SET used = TRUE, used_at = NOW()
            WHERE id = ?
        `, [state.id]);

        return {
            provider: state.provider,
            action: state.action,
            userId: state.user_id,
            returnUrl: state.return_url
        };
    }

    /**
     * Find user by OAuth provider and provider user ID
     * @param {string} provider - OAuth provider
     * @param {string} providerUserId - User ID from OAuth provider
     * @returns {Promise<Object|null>} User or null
     */
    async findUserByOAuth(provider, providerUserId) {
        const accounts = await query(`
            SELECT oa.*, u.id as user_id, u.email, u.role
            FROM oauth_accounts oa
            JOIN users u ON oa.user_id = u.id
            WHERE oa.provider = ?
            AND oa.provider_user_id = ?
            AND oa.revoked = FALSE
        `, [provider, providerUserId]);

        return accounts.length > 0 ? accounts[0] : null;
    }

    /**
     * Find user by email
     * @param {string} email - Email address
     * @returns {Promise<Object|null>} User or null
     */
    async findUserByEmail(email) {
        const users = await query(`
            SELECT id, email, role, is_active FROM users WHERE email = ?
        `, [email]);

        return users.length > 0 ? users[0] : null;
    }

    /**
     * Create new user from OAuth profile
     * @param {string} provider - OAuth provider
     * @param {Object} profile - OAuth profile data
     * @returns {Promise<Object>} Created user
     */
    async createUserFromOAuth(provider, profile) {
        const email = profile.email;
        const name = profile.name || profile.displayName || email.split('@')[0];

        // Create user (no password needed for OAuth users)
        const result = await query(`
            INSERT INTO users (
                email, role, is_active,
                oauth_signup, oauth_primary_provider,
                email_verified, email_verified_at,
                created_at, updated_at
            )
            VALUES (?, 'model', TRUE, TRUE, ?, TRUE, NOW(), NOW(), NOW())
        `, [email, provider]);

        const userId = result.insertId;

        // Create default model for user
        const modelSlug = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
        const modelName = name;

        const modelResult = await query(`
            INSERT INTO models (name, slug, status, created_at, updated_at)
            VALUES (?, ?, 'trial', NOW(), NOW())
        `, [modelName, modelSlug]);

        const modelId = modelResult.insertId;

        // Create model-user relationship
        await query(`
            INSERT INTO model_users (model_id, user_id, role, is_active, added_at)
            VALUES (?, ?, 'owner', TRUE, NOW())
        `, [modelId, userId]);

        // Create default site settings
        await query(`
            INSERT INTO site_settings (model_id, site_name, model_name, created_at, updated_at)
            VALUES (?, ?, ?, NOW(), NOW())
        `, [modelId, `${modelName}'s Portfolio`, modelName]);

        console.log(`✅ Created user ${userId} from ${provider} OAuth`);

        return {
            id: userId,
            email: email,
            role: 'model',
            modelId: modelId
        };
    }

    /**
     * Link OAuth account to existing user
     * @param {number} userId - User ID
     * @param {string} provider - OAuth provider
     * @param {Object} profile - OAuth profile data
     * @param {Object} tokens - OAuth tokens (optional)
     * @returns {Promise<number>} OAuth account ID
     */
    async linkOAuthAccount(userId, provider, profile, tokens = null) {
        const providerUserId = profile.id || profile.sub;
        const email = profile.email;
        const name = profile.name || profile.displayName;
        const avatarUrl = profile.picture || profile.avatar_url || profile.photos?.[0]?.value;

        // Check if account already linked
        const existing = await query(`
            SELECT id FROM oauth_accounts
            WHERE user_id = ? AND provider = ?
        `, [userId, provider]);

        if (existing.length > 0) {
            // Update existing link
            await query(`
                UPDATE oauth_accounts
                SET provider_user_id = ?,
                    provider_email = ?,
                    provider_name = ?,
                    provider_avatar_url = ?,
                    access_token = ?,
                    refresh_token = ?,
                    token_expires_at = ?,
                    raw_profile = ?,
                    last_used_at = NOW(),
                    updated_at = NOW()
                WHERE id = ?
            `, [
                providerUserId,
                email,
                name,
                avatarUrl,
                tokens?.accessToken || null,
                tokens?.refreshToken || null,
                tokens?.expiresAt || null,
                JSON.stringify(profile),
                existing[0].id
            ]);

            return existing[0].id;
        }

        // Create new link
        const result = await query(`
            INSERT INTO oauth_accounts (
                user_id, provider, provider_user_id,
                provider_email, provider_name, provider_avatar_url,
                access_token, refresh_token, token_expires_at,
                raw_profile,
                linked_at, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
        `, [
            userId,
            provider,
            providerUserId,
            email,
            name,
            avatarUrl,
            tokens?.accessToken || null,
            tokens?.refreshToken || null,
            tokens?.expiresAt || null,
            JSON.stringify(profile)
        ]);

        // Update provider statistics
        await query(`
            UPDATE oauth_providers
            SET total_connections = total_connections + 1
            WHERE provider = ?
        `, [provider]);

        console.log(`🔗 Linked ${provider} account to user ${userId}`);

        return result.insertId;
    }

    /**
     * Update OAuth account usage
     * @param {string} provider - OAuth provider
     * @param {string} providerUserId - Provider user ID
     * @returns {Promise<void>}
     */
    async updateOAuthUsage(provider, providerUserId) {
        await query(`
            UPDATE oauth_accounts
            SET last_used_at = NOW()
            WHERE provider = ? AND provider_user_id = ?
        `, [provider, providerUserId]);
    }

    /**
     * Get user's linked OAuth accounts
     * @param {number} userId - User ID
     * @returns {Promise<Array>}
     */
    async getUserOAuthAccounts(userId) {
        return await query(`
            SELECT
                id, provider, provider_email, provider_name,
                provider_avatar_url, linked_at, last_used_at,
                is_primary, revoked
            FROM oauth_accounts
            WHERE user_id = ?
            AND revoked = FALSE
            ORDER BY is_primary DESC, linked_at DESC
        `, [userId]);
    }

    /**
     * Revoke OAuth account link
     * @param {number} accountId - OAuth account ID
     * @param {number} userId - User ID (for verification)
     * @returns {Promise<void>}
     */
    async revokeOAuthAccount(accountId, userId) {
        await query(`
            UPDATE oauth_accounts
            SET revoked = TRUE,
                revoked_at = NOW(),
                updated_at = NOW()
            WHERE id = ? AND user_id = ?
        `, [accountId, userId]);

        console.log(`🚫 Revoked OAuth account ${accountId}`);
    }

    /**
     * Get OAuth provider configuration
     * @param {string} provider - Provider name
     * @returns {Promise<Object|null>}
     */
    async getProviderConfig(provider) {
        const configs = await query(`
            SELECT * FROM oauth_providers
            WHERE provider = ? AND enabled = TRUE
        `, [provider]);

        return configs.length > 0 ? configs[0] : null;
    }

    /**
     * Check if provider is enabled
     * @param {string} provider - Provider name
     * @returns {Promise<boolean>}
     */
    async isProviderEnabled(provider) {
        const config = await this.getProviderConfig(provider);
        return config !== null && config.enabled === 1;
    }

    /**
     * Cleanup expired state tokens (maintenance)
     * @returns {Promise<number>} Number of deleted tokens
     */
    async cleanupExpiredStateTokens() {
        const result = await query(`
            DELETE FROM oauth_state_tokens
            WHERE expires_at < NOW()
        `);

        console.log(`🧹 Cleaned up ${result.affectedRows} expired OAuth state tokens`);
        return result.affectedRows;
    }
}

module.exports = new OAuthService();
