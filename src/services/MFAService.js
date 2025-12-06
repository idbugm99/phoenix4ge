const { query } = require('../../config/database');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const crypto = require('crypto');

/**
 * MFAService - Multi-Factor Authentication service
 *
 * Features:
 * - TOTP (Time-based One-Time Password) using authenticator apps
 * - Backup recovery codes (10 per user)
 * - Trusted device management (30-day trust)
 * - MFA challenge sessions
 * - Support for Google Authenticator, Authy, Microsoft Authenticator, etc.
 *
 * CRITICAL: Required for Stripe integration
 */
class MFAService {
    /**
     * Generate a new TOTP secret for a user
     * @param {number} userId - User ID
     * @param {string} email - User's email (for QR code label)
     * @returns {Promise<Object>} { secret, qrCodeUrl, qrCodeDataUrl }
     */
    async generateTOTPSecret(userId, email) {
        // Generate secret
        const secret = speakeasy.generateSecret({
            name: `Phoenix4GE (${email})`,
            issuer: 'Phoenix4GE',
            length: 32
        });

        // Store secret in database (not yet enabled)
        const existing = await query(`
            SELECT id FROM mfa_configurations
            WHERE user_id = ? AND method = 'totp'
        `, [userId]);

        if (existing.length > 0) {
            // Update existing configuration
            await query(`
                UPDATE mfa_configurations
                SET secret = ?, enabled = FALSE, updated_at = NOW()
                WHERE user_id = ? AND method = 'totp'
            `, [secret.base32, userId]);
        } else {
            // Create new configuration
            await query(`
                INSERT INTO mfa_configurations (
                    user_id, method, secret, enabled, created_at
                )
                VALUES (?, 'totp', ?, FALSE, NOW())
            `, [userId, secret.base32]);
        }

        // Generate QR code data URL for frontend display
        const qrCodeDataUrl = await QRCode.toDataURL(secret.otpauth_url);

        console.log(`🔐 Generated TOTP secret for user ${userId}`);

        return {
            secret: secret.base32,
            qrCodeUrl: secret.otpauth_url,
            qrCodeDataUrl: qrCodeDataUrl,
            note: 'Scan this QR code with your authenticator app (Google Authenticator, Authy, etc.)'
        };
    }

    /**
     * Verify a TOTP token and enable MFA
     * @param {number} userId - User ID
     * @param {string} token - 6-digit TOTP token
     * @returns {Promise<Object>} { verified: boolean, backupCodes?: string[] }
     */
    async verifyAndEnableTOTP(userId, token) {
        // Get user's TOTP secret
        const configs = await query(`
            SELECT id, secret, enabled
            FROM mfa_configurations
            WHERE user_id = ? AND method = 'totp'
        `, [userId]);

        if (configs.length === 0) {
            throw new Error('MFA configuration not found. Please start enrollment first.');
        }

        const config = configs[0];

        // Verify token
        const verified = speakeasy.totp.verify({
            secret: config.secret,
            encoding: 'base32',
            token: token,
            window: 2 // Allow 2 time steps (60 seconds) of drift
        });

        if (!verified) {
            return { verified: false, message: 'Invalid verification code' };
        }

        // Enable MFA
        await query(`
            UPDATE mfa_configurations
            SET enabled = TRUE,
                verified_at = NOW(),
                last_used_at = NOW(),
                failed_attempts = 0,
                updated_at = NOW()
            WHERE id = ?
        `, [config.id]);

        // Update user's MFA status
        await query(`
            UPDATE users
            SET mfa_enabled = TRUE,
                mfa_enabled_at = NOW(),
                mfa_method = 'totp',
                updated_at = NOW()
            WHERE id = ?
        `, [userId]);

        // Generate backup codes
        const backupCodes = await this.generateBackupCodes(userId);

        console.log(`✅ MFA enabled for user ${userId}`);

        return {
            verified: true,
            message: 'MFA successfully enabled',
            backupCodes: backupCodes,
            note: 'Save these backup codes in a safe place. Each code can be used once.'
        };
    }

    /**
     * Verify a TOTP token (for login challenge)
     * @param {number} userId - User ID
     * @param {string} token - 6-digit TOTP token
     * @returns {Promise<boolean>}
     */
    async verifyTOTP(userId, token) {
        const configs = await query(`
            SELECT id, secret, enabled
            FROM mfa_configurations
            WHERE user_id = ? AND method = 'totp' AND enabled = TRUE
        `, [userId]);

        if (configs.length === 0) {
            return false;
        }

        const config = configs[0];

        const verified = speakeasy.totp.verify({
            secret: config.secret,
            encoding: 'base32',
            token: token,
            window: 2
        });

        if (verified) {
            // Update last used timestamp
            await query(`
                UPDATE mfa_configurations
                SET last_used_at = NOW(),
                    failed_attempts = 0,
                    updated_at = NOW()
                WHERE id = ?
            `, [config.id]);

            console.log(`✅ TOTP verified for user ${userId}`);
        } else {
            // Increment failed attempts
            await query(`
                UPDATE mfa_configurations
                SET failed_attempts = failed_attempts + 1,
                    updated_at = NOW()
                WHERE id = ?
            `, [config.id]);

            console.log(`❌ TOTP verification failed for user ${userId}`);
        }

        return verified;
    }

    /**
     * Generate backup recovery codes
     * @param {number} userId - User ID
     * @returns {Promise<string[]>} Array of 10 backup codes
     */
    async generateBackupCodes(userId) {
        // Delete existing unused backup codes
        await query(`
            DELETE FROM mfa_backup_codes
            WHERE user_id = ? AND used = FALSE
        `, [userId]);

        const backupCodes = [];

        // Generate 10 backup codes
        for (let i = 0; i < 10; i++) {
            // Generate random 8-character code (alphanumeric, uppercase)
            const code = crypto.randomBytes(4).toString('hex').toUpperCase();
            backupCodes.push(code);

            // Hash code before storing
            const codeHash = crypto.createHash('sha256').update(code).digest('hex');

            await query(`
                INSERT INTO mfa_backup_codes (user_id, code_hash, created_at)
                VALUES (?, ?, NOW())
            `, [userId, codeHash]);
        }

        // Mark backup codes as generated
        await query(`
            UPDATE mfa_configurations
            SET backup_codes_generated = TRUE,
                updated_at = NOW()
            WHERE user_id = ? AND method = 'totp'
        `, [userId]);

        console.log(`🔑 Generated 10 backup codes for user ${userId}`);

        return backupCodes;
    }

    /**
     * Verify a backup recovery code
     * @param {number} userId - User ID
     * @param {string} code - Backup code
     * @param {string} ipAddress - IP address (for logging)
     * @returns {Promise<boolean>}
     */
    async verifyBackupCode(userId, code, ipAddress = null) {
        // Hash provided code
        const codeHash = crypto.createHash('sha256').update(code.toUpperCase()).digest('hex');

        // Find matching unused code
        const codes = await query(`
            SELECT id FROM mfa_backup_codes
            WHERE user_id = ? AND code_hash = ? AND used = FALSE
        `, [userId, codeHash]);

        if (codes.length === 0) {
            console.log(`❌ Invalid backup code for user ${userId}`);
            return false;
        }

        // Mark code as used
        await query(`
            UPDATE mfa_backup_codes
            SET used = TRUE,
                used_at = NOW(),
                used_ip_address = ?
            WHERE id = ?
        `, [ipAddress, codes[0].id]);

        console.log(`✅ Backup code verified for user ${userId}`);

        // Check if this was the last unused code
        const remainingCodes = await query(`
            SELECT COUNT(*) as count FROM mfa_backup_codes
            WHERE user_id = ? AND used = FALSE
        `, [userId]);

        if (remainingCodes[0].count === 0) {
            console.log(`⚠️  User ${userId} has no remaining backup codes`);
            // Consider sending notification to user
        }

        return true;
    }

    /**
     * Get remaining backup codes count
     * @param {number} userId - User ID
     * @returns {Promise<number>}
     */
    async getRemainingBackupCodesCount(userId) {
        const result = await query(`
            SELECT COUNT(*) as count FROM mfa_backup_codes
            WHERE user_id = ? AND used = FALSE
        `, [userId]);

        return result[0].count;
    }

    /**
     * Create MFA challenge session (after password verification)
     * @param {number} userId - User ID
     * @param {string} ipAddress - IP address
     * @param {string} userAgent - User agent
     * @returns {Promise<string>} Challenge session token
     */
    async createChallengeSession(userId, ipAddress, userAgent) {
        // Generate session token
        const sessionToken = crypto.randomBytes(32).toString('hex');

        // Get user's primary MFA method
        const users = await query(`
            SELECT mfa_method FROM users WHERE id = ?
        `, [userId]);

        const method = users[0]?.mfa_method || 'totp';

        // Create challenge session (expires in 5 minutes)
        await query(`
            INSERT INTO mfa_challenge_sessions (
                user_id, session_token, method,
                ip_address, user_agent,
                expires_at, created_at
            )
            VALUES (?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 5 MINUTE), NOW())
        `, [userId, sessionToken, method, ipAddress, userAgent]);

        console.log(`🔐 Created MFA challenge session for user ${userId}`);

        return sessionToken;
    }

    /**
     * Verify MFA challenge session
     * @param {string} sessionToken - Challenge session token
     * @param {string} mfaCode - TOTP code or backup code
     * @param {string} ipAddress - IP address (for backup code logging)
     * @returns {Promise<Object>} { verified: boolean, userId?: number }
     */
    async verifyChallengeSession(sessionToken, mfaCode, ipAddress = null) {
        // Get challenge session
        const sessions = await query(`
            SELECT id, user_id, method, verified, expires_at, attempts
            FROM mfa_challenge_sessions
            WHERE session_token = ?
        `, [sessionToken]);

        if (sessions.length === 0) {
            return { verified: false, error: 'Invalid or expired challenge session' };
        }

        const session = sessions[0];

        // Check if already verified
        if (session.verified) {
            return { verified: false, error: 'Challenge already verified' };
        }

        // Check expiry
        if (new Date(session.expires_at) < new Date()) {
            return { verified: false, error: 'Challenge session expired' };
        }

        // Check attempt limit (max 5 attempts)
        if (session.attempts >= 5) {
            return { verified: false, error: 'Too many verification attempts' };
        }

        // Try TOTP first
        let verified = await this.verifyTOTP(session.user_id, mfaCode);

        // If TOTP fails, try backup code
        if (!verified) {
            verified = await this.verifyBackupCode(session.user_id, mfaCode, ipAddress);
        }

        if (verified) {
            // Mark session as verified
            await query(`
                UPDATE mfa_challenge_sessions
                SET verified = TRUE,
                    verified_at = NOW()
                WHERE id = ?
            `, [session.id]);

            console.log(`✅ MFA challenge verified for user ${session.user_id}`);

            return {
                verified: true,
                userId: session.user_id
            };
        } else {
            // Increment attempts
            await query(`
                UPDATE mfa_challenge_sessions
                SET attempts = attempts + 1
                WHERE id = ?
            `, [session.id]);

            return {
                verified: false,
                error: 'Invalid verification code',
                attemptsRemaining: 5 - (session.attempts + 1)
            };
        }
    }

    /**
     * Trust a device for 30 days
     * @param {number} userId - User ID
     * @param {string} ipAddress - IP address
     * @param {string} userAgent - User agent
     * @param {string} deviceName - User-friendly device name
     * @returns {Promise<string>} Device fingerprint
     */
    async trustDevice(userId, ipAddress, userAgent, deviceName = null) {
        // Generate device fingerprint
        const fingerprintData = `${userId}:${ipAddress}:${userAgent}`;
        const deviceFingerprint = crypto.createHash('sha256').update(fingerprintData).digest('hex');

        // Parse device info from user agent (basic parsing)
        const deviceInfo = this.parseUserAgent(userAgent);

        // Check if device already trusted
        const existing = await query(`
            SELECT id FROM mfa_trusted_devices
            WHERE user_id = ? AND device_fingerprint = ? AND revoked = FALSE
        `, [userId, deviceFingerprint]);

        if (existing.length > 0) {
            // Update expiry to 30 days from now
            await query(`
                UPDATE mfa_trusted_devices
                SET expires_at = DATE_ADD(NOW(), INTERVAL 30 DAY),
                    last_used_at = NOW(),
                    updated_at = NOW()
                WHERE id = ?
            `, [existing[0].id]);
        } else {
            // Create new trusted device
            await query(`
                INSERT INTO mfa_trusted_devices (
                    user_id, device_fingerprint, device_name, device_info,
                    ip_address, user_agent,
                    expires_at, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 30 DAY), NOW())
            `, [
                userId,
                deviceFingerprint,
                deviceName || `${deviceInfo.browser} on ${deviceInfo.os}`,
                JSON.stringify(deviceInfo),
                ipAddress,
                userAgent
            ]);
        }

        console.log(`✅ Device trusted for 30 days: User ${userId}`);

        return deviceFingerprint;
    }

    /**
     * Check if device is trusted
     * @param {number} userId - User ID
     * @param {string} ipAddress - IP address
     * @param {string} userAgent - User agent
     * @returns {Promise<boolean>}
     */
    async isDeviceTrusted(userId, ipAddress, userAgent) {
        const fingerprintData = `${userId}:${ipAddress}:${userAgent}`;
        const deviceFingerprint = crypto.createHash('sha256').update(fingerprintData).digest('hex');

        const devices = await query(`
            SELECT id FROM mfa_trusted_devices
            WHERE user_id = ?
            AND device_fingerprint = ?
            AND revoked = FALSE
            AND expires_at > NOW()
        `, [userId, deviceFingerprint]);

        if (devices.length > 0) {
            // Update last used timestamp
            await query(`
                UPDATE mfa_trusted_devices
                SET last_used_at = NOW()
                WHERE id = ?
            `, [devices[0].id]);

            return true;
        }

        return false;
    }

    /**
     * Get all trusted devices for a user
     * @param {number} userId - User ID
     * @returns {Promise<Array>}
     */
    async getTrustedDevices(userId) {
        return await query(`
            SELECT
                id, device_name, device_info,
                ip_address, trusted_at, expires_at,
                last_used_at, revoked
            FROM mfa_trusted_devices
            WHERE user_id = ?
            AND revoked = FALSE
            ORDER BY last_used_at DESC
        `, [userId]);
    }

    /**
     * Revoke a trusted device
     * @param {number} deviceId - Device ID
     * @param {number} userId - User ID (for verification)
     * @returns {Promise<void>}
     */
    async revokeTrustedDevice(deviceId, userId) {
        await query(`
            UPDATE mfa_trusted_devices
            SET revoked = TRUE,
                revoked_at = NOW(),
                updated_at = NOW()
            WHERE id = ? AND user_id = ?
        `, [deviceId, userId]);

        console.log(`🚫 Revoked trusted device ${deviceId} for user ${userId}`);
    }

    /**
     * Disable MFA for a user
     * @param {number} userId - User ID
     * @returns {Promise<void>}
     */
    async disableMFA(userId) {
        // Disable MFA configuration
        await query(`
            UPDATE mfa_configurations
            SET enabled = FALSE, updated_at = NOW()
            WHERE user_id = ?
        `, [userId]);

        // Update user's MFA status
        await query(`
            UPDATE users
            SET mfa_enabled = FALSE,
                mfa_method = NULL,
                updated_at = NOW()
            WHERE id = ?
        `, [userId]);

        // Revoke all trusted devices
        await query(`
            UPDATE mfa_trusted_devices
            SET revoked = TRUE,
                revoked_at = NOW(),
                updated_at = NOW()
            WHERE user_id = ? AND revoked = FALSE
        `, [userId]);

        console.log(`🔓 MFA disabled for user ${userId}`);
    }

    /**
     * Check if user has MFA enabled
     * @param {number} userId - User ID
     * @returns {Promise<boolean>}
     */
    async isMFAEnabled(userId) {
        const users = await query(`
            SELECT mfa_enabled FROM users WHERE id = ?
        `, [userId]);

        return users.length > 0 && users[0].mfa_enabled === 1;
    }

    /**
     * Parse user agent string (basic parsing)
     * @param {string} userAgent - User agent string
     * @returns {Object} { browser, os, device }
     */
    parseUserAgent(userAgent) {
        const ua = userAgent || '';

        // Browser detection
        let browser = 'Unknown';
        if (ua.includes('Chrome')) browser = 'Chrome';
        else if (ua.includes('Firefox')) browser = 'Firefox';
        else if (ua.includes('Safari')) browser = 'Safari';
        else if (ua.includes('Edge')) browser = 'Edge';

        // OS detection
        let os = 'Unknown';
        if (ua.includes('Windows')) os = 'Windows';
        else if (ua.includes('Mac')) os = 'macOS';
        else if (ua.includes('Linux')) os = 'Linux';
        else if (ua.includes('Android')) os = 'Android';
        else if (ua.includes('iOS') || ua.includes('iPhone') || ua.includes('iPad')) os = 'iOS';

        // Device type
        let device = 'Desktop';
        if (ua.includes('Mobile')) device = 'Mobile';
        else if (ua.includes('Tablet')) device = 'Tablet';

        return { browser, os, device };
    }

    /**
     * Cleanup expired challenge sessions (maintenance)
     * @returns {Promise<number>} Number of deleted sessions
     */
    async cleanupExpiredSessions() {
        const result = await query(`
            DELETE FROM mfa_challenge_sessions
            WHERE expires_at < NOW()
        `);

        console.log(`🧹 Cleaned up ${result.affectedRows} expired MFA challenge sessions`);
        return result.affectedRows;
    }
}

module.exports = new MFAService();
