/**
 * RefreshTokenService - Handle refresh token generation, rotation, and validation
 * Phase 1.3 of Authentication & Onboarding Implementation Plan
 * Architecture: 15-minute access tokens + 30-day refresh tokens with automatic rotation
 */

const crypto = require('crypto');
const { query } = require('../../config/database');
const { generateToken } = require('../../middleware/auth');

class RefreshTokenService {
    constructor() {
        this.refreshTokenExpiryDays = parseInt(process.env.REFRESH_TOKEN_EXPIRY_DAYS) || 30;
        this.accessTokenExpiryMinutes = parseInt(process.env.ACCESS_TOKEN_EXPIRY_MINUTES) || 15;
        this.enableTokenRotation = process.env.ENABLE_TOKEN_ROTATION !== 'false'; // Default: true
    }

    /**
     * Generate a cryptographically secure refresh token
     * @private
     */
    _generateToken() {
        return crypto.randomBytes(32).toString('hex');
    }

    /**
     * Hash a token using SHA-256
     * @private
     */
    _hashToken(token) {
        return crypto.createHash('sha256').update(token).digest('hex');
    }

    /**
     * Parse device info from user agent
     * @private
     */
    _parseDeviceInfo(userAgent) {
        if (!userAgent) return null;

        const deviceInfo = {
            browser: 'Unknown',
            os: 'Unknown',
            device: 'Desktop'
        };

        // Simple user agent parsing (can be enhanced with a library like ua-parser-js)
        if (userAgent.includes('Chrome')) deviceInfo.browser = 'Chrome';
        else if (userAgent.includes('Firefox')) deviceInfo.browser = 'Firefox';
        else if (userAgent.includes('Safari')) deviceInfo.browser = 'Safari';
        else if (userAgent.includes('Edge')) deviceInfo.browser = 'Edge';

        if (userAgent.includes('Windows')) deviceInfo.os = 'Windows';
        else if (userAgent.includes('Mac')) deviceInfo.os = 'macOS';
        else if (userAgent.includes('Linux')) deviceInfo.os = 'Linux';
        else if (userAgent.includes('Android')) deviceInfo.os = 'Android';
        else if (userAgent.includes('iPhone') || userAgent.includes('iPad')) deviceInfo.os = 'iOS';

        if (userAgent.includes('Mobile') || userAgent.includes('Android') || userAgent.includes('iPhone')) {
            deviceInfo.device = 'Mobile';
        } else if (userAgent.includes('Tablet') || userAgent.includes('iPad')) {
            deviceInfo.device = 'Tablet';
        }

        return deviceInfo;
    }

    /**
     * Create a new refresh token for a user
     * @param {number} userId - User ID
     * @param {string} ipAddress - Request IP address
     * @param {string} userAgent - Request user agent
     * @returns {Promise<Object>} Object containing refresh token and access token
     */
    async createRefreshToken(userId, ipAddress = null, userAgent = null) {
        try {
            // Generate refresh token
            const refreshToken = this._generateToken();
            const refreshTokenHash = this._hashToken(refreshToken);

            // Calculate expiry
            const expiresAt = new Date();
            expiresAt.setDate(expiresAt.getDate() + this.refreshTokenExpiryDays);

            // Parse device info
            const deviceInfo = this._parseDeviceInfo(userAgent);

            // Store refresh token
            await query(`
                INSERT INTO refresh_tokens (
                    user_id,
                    token_hash,
                    expires_at,
                    device_info,
                    ip_address,
                    user_agent,
                    last_used_at,
                    usage_count,
                    max_usage,
                    created_at
                ) VALUES (?, ?, ?, ?, ?, ?, NOW(), 0, ?, NOW())
            `, [
                userId,
                refreshTokenHash,
                expiresAt,
                deviceInfo ? JSON.stringify(deviceInfo) : null,
                ipAddress,
                userAgent,
                this.enableTokenRotation ? 1 : 999 // One-time use if rotation enabled
            ]);

            // Get user data for access token
            const users = await query(`
                SELECT id, email, role
                FROM users
                WHERE id = ?
            `, [userId]);

            if (users.length === 0) {
                throw new Error('User not found');
            }

            const user = users[0];

            // Generate short-lived access token
            const accessToken = generateToken(user);

            console.log(`🔑 Created refresh token for user ${userId} (expires in ${this.refreshTokenExpiryDays} days)`);

            return {
                refreshToken,
                accessToken,
                expiresIn: this.accessTokenExpiryMinutes * 60, // seconds
                tokenType: 'Bearer'
            };

        } catch (error) {
            console.error('Create refresh token error:', error);
            throw error;
        }
    }

    /**
     * Use a refresh token to generate a new access token
     * @param {string} refreshToken - Refresh token (unhashed)
     * @param {string} ipAddress - Request IP address
     * @param {string} userAgent - Request user agent
     * @returns {Promise<Object>} Object containing new access token and optionally new refresh token
     */
    async useRefreshToken(refreshToken, ipAddress = null, userAgent = null) {
        try {
            const tokenHash = this._hashToken(refreshToken);

            // Find valid refresh token
            const tokens = await query(`
                SELECT rt.*, u.id as user_id, u.email, u.role, u.token_version, u.is_active
                FROM refresh_tokens rt
                JOIN users u ON rt.user_id = u.id
                WHERE rt.token_hash = ?
                  AND rt.revoked_at IS NULL
                  AND rt.expires_at > NOW()
                  AND rt.usage_count < rt.max_usage
                ORDER BY rt.created_at DESC
                LIMIT 1
            `, [tokenHash]);

            if (tokens.length === 0) {
                return {
                    success: false,
                    error: 'invalid_token',
                    message: 'Invalid or expired refresh token'
                };
            }

            const tokenData = tokens[0];

            // Check if user is active
            if (!tokenData.is_active) {
                return {
                    success: false,
                    error: 'account_disabled',
                    message: 'Account has been disabled'
                };
            }

            // Update usage count and last used
            await query(`
                UPDATE refresh_tokens
                SET usage_count = usage_count + 1,
                    last_used_at = NOW(),
                    updated_at = NOW()
                WHERE id = ?
            `, [tokenData.id]);

            // Generate new access token
            const user = {
                id: tokenData.user_id,
                email: tokenData.email,
                role: tokenData.role
            };
            const accessToken = generateToken(user);

            const result = {
                success: true,
                accessToken,
                expiresIn: this.accessTokenExpiryMinutes * 60, // seconds
                tokenType: 'Bearer'
            };

            // If token rotation is enabled, generate new refresh token
            if (this.enableTokenRotation) {
                // Revoke old refresh token
                await query(`
                    UPDATE refresh_tokens
                    SET revoked_at = NOW()
                    WHERE id = ?
                `, [tokenData.id]);

                // Create new refresh token
                const newTokens = await this.createRefreshToken(tokenData.user_id, ipAddress, userAgent);

                // Link old token to new token for audit trail
                await query(`
                    UPDATE refresh_tokens
                    SET replaced_by_token_hash = ?
                    WHERE id = ?
                `, [this._hashToken(newTokens.refreshToken), tokenData.id]);

                result.refreshToken = newTokens.refreshToken;
                console.log(`🔄 Rotated refresh token for user ${tokenData.user_id}`);
            }

            return result;

        } catch (error) {
            console.error('Use refresh token error:', error);
            throw error;
        }
    }

    /**
     * Revoke a specific refresh token
     * @param {string} refreshToken - Refresh token to revoke (unhashed)
     * @returns {Promise<boolean>} Success status
     */
    async revokeRefreshToken(refreshToken) {
        try {
            const tokenHash = this._hashToken(refreshToken);

            const result = await query(`
                UPDATE refresh_tokens
                SET revoked_at = NOW()
                WHERE token_hash = ?
                  AND revoked_at IS NULL
            `, [tokenHash]);

            return result.affectedRows > 0;

        } catch (error) {
            console.error('Revoke refresh token error:', error);
            throw error;
        }
    }

    /**
     * Revoke all refresh tokens for a user
     * @param {number} userId - User ID
     * @returns {Promise<number>} Number of tokens revoked
     */
    async revokeAllUserTokens(userId) {
        try {
            const result = await query(`
                UPDATE refresh_tokens
                SET revoked_at = NOW()
                WHERE user_id = ?
                  AND revoked_at IS NULL
            `, [userId]);

            console.log(`🚫 Revoked ${result.affectedRows} refresh tokens for user ${userId}`);
            return result.affectedRows;

        } catch (error) {
            console.error('Revoke all tokens error:', error);
            throw error;
        }
    }

    /**
     * Get active sessions for a user
     * @param {number} userId - User ID
     * @returns {Promise<Array>} Array of active sessions
     */
    async getUserSessions(userId) {
        const sessions = await query(`
            SELECT
                id,
                device_info,
                ip_address,
                last_used_at,
                usage_count,
                created_at,
                expires_at
            FROM refresh_tokens
            WHERE user_id = ?
              AND revoked_at IS NULL
              AND expires_at > NOW()
            ORDER BY last_used_at DESC
        `, [userId]);

        return sessions.map(session => ({
            id: session.id,
            device: session.device_info ? JSON.parse(session.device_info) : null,
            ipAddress: session.ip_address,
            lastUsed: session.last_used_at,
            usageCount: session.usage_count,
            createdAt: session.created_at,
            expiresAt: session.expires_at
        }));
    }

    /**
     * Revoke a specific session by ID
     * @param {number} userId - User ID (for authorization check)
     * @param {number} sessionId - Session/token ID
     * @returns {Promise<boolean>} Success status
     */
    async revokeSession(userId, sessionId) {
        try {
            const result = await query(`
                UPDATE refresh_tokens
                SET revoked_at = NOW()
                WHERE id = ?
                  AND user_id = ?
                  AND revoked_at IS NULL
            `, [sessionId, userId]);

            return result.affectedRows > 0;

        } catch (error) {
            console.error('Revoke session error:', error);
            throw error;
        }
    }

    /**
     * Clean up expired and revoked refresh tokens
     * @param {number} daysOld - Delete tokens older than this many days (default: 90)
     * @returns {Promise<number>} Number of tokens deleted
     */
    async cleanupExpiredTokens(daysOld = 90) {
        const result = await query(`
            DELETE FROM refresh_tokens
            WHERE (revoked_at IS NOT NULL OR expires_at < NOW())
              AND created_at < DATE_SUB(NOW(), INTERVAL ? DAY)
        `, [daysOld]);

        if (result.affectedRows > 0) {
            console.log(`🧹 Cleaned up ${result.affectedRows} expired refresh tokens`);
        }

        return result.affectedRows;
    }

    /**
     * Get refresh token statistics for monitoring
     * @returns {Promise<Object>} Token statistics
     */
    async getTokenStats() {
        const stats = await query(`
            SELECT
                COUNT(*) as total_tokens,
                SUM(CASE WHEN revoked_at IS NULL AND expires_at > NOW() THEN 1 ELSE 0 END) as active_tokens,
                SUM(CASE WHEN revoked_at IS NOT NULL THEN 1 ELSE 0 END) as revoked_tokens,
                SUM(CASE WHEN expires_at <= NOW() THEN 1 ELSE 0 END) as expired_tokens,
                AVG(usage_count) as avg_usage_count
            FROM refresh_tokens
        `);

        return stats[0];
    }
}

// Export singleton instance
module.exports = new RefreshTokenService();
