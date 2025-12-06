const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../../middleware/auth');
const mfaService = require('../services/MFAService');
const authAuditService = require('../services/AuthAuditService');

const router = express.Router();

/**
 * POST /api/auth/mfa/enroll/start
 * Start MFA enrollment process (generate QR code)
 * Requires authentication
 */
router.post('/mfa/enroll/start', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const email = req.user.email;

        // Check if MFA already enabled
        const mfaEnabled = await mfaService.isMFAEnabled(userId);
        if (mfaEnabled) {
            return res.fail(400, 'MFA already enabled', {
                message: 'MFA is already enabled for your account'
            });
        }

        // Generate TOTP secret and QR code
        const enrollment = await mfaService.generateTOTPSecret(userId, email);

        // Log audit event
        await authAuditService.logEvent({
            eventType: 'mfa_enrollment_started',
            eventCategory: 'security',
            userId: userId,
            email: email,
            success: true,
            ipAddress: req.ip,
            userAgent: req.get('user-agent')
        });

        res.json({
            message: 'MFA enrollment started',
            secret: enrollment.secret,
            qrCode: enrollment.qrCodeDataUrl,
            note: enrollment.note,
            instructions: [
                '1. Install an authenticator app (Google Authenticator, Authy, Microsoft Authenticator)',
                '2. Scan the QR code with your app',
                '3. Enter the 6-digit code from your app to verify'
            ]
        });

    } catch (error) {
        console.error('MFA enrollment start error:', error);
        res.fail(500, 'Enrollment failed', {
            message: 'Unable to start MFA enrollment'
        });
    }
});

/**
 * POST /api/auth/mfa/enroll/verify
 * Verify TOTP token and enable MFA
 * Requires authentication
 */
router.post('/mfa/enroll/verify', [
    authenticateToken,
    body('token')
        .isLength({ min: 6, max: 6 })
        .isNumeric()
        .withMessage('Token must be a 6-digit code')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.fail(400, 'Validation failed', {
                message: 'Please check your input',
                details: errors.array()
            });
        }

        const userId = req.user.id;
        const email = req.user.email;
        const { token } = req.body;

        // Verify token and enable MFA
        const result = await mfaService.verifyAndEnableTOTP(userId, token);

        if (!result.verified) {
            // Log failed verification
            await authAuditService.logEvent({
                eventType: 'mfa_enrollment_failed',
                eventCategory: 'security',
                userId: userId,
                email: email,
                success: false,
                failureReason: 'invalid_token',
                ipAddress: req.ip,
                userAgent: req.get('user-agent')
            });

            return res.fail(400, 'Verification failed', {
                message: result.message
            });
        }

        // Log successful MFA enablement
        await authAuditService.logEvent({
            eventType: 'mfa_enabled',
            eventCategory: 'security',
            userId: userId,
            email: email,
            success: true,
            ipAddress: req.ip,
            userAgent: req.get('user-agent'),
            metadata: { method: 'totp' }
        });

        res.json({
            message: result.message,
            backupCodes: result.backupCodes,
            note: result.note,
            warning: 'IMPORTANT: Save these backup codes securely. They can be used if you lose access to your authenticator app.'
        });

    } catch (error) {
        console.error('MFA enrollment verify error:', error);
        res.fail(500, 'Verification failed', {
            message: error.message || 'Unable to verify MFA'
        });
    }
});

/**
 * POST /api/auth/mfa/challenge/verify
 * Verify MFA challenge during login
 * Public endpoint (uses challenge session token)
 */
router.post('/mfa/challenge/verify', [
    body('sessionToken')
        .notEmpty()
        .withMessage('Session token is required'),
    body('code')
        .notEmpty()
        .withMessage('Verification code is required')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.fail(400, 'Validation failed', {
                message: 'Please check your input',
                details: errors.array()
            });
        }

        const { sessionToken, code, trustDevice } = req.body;
        const ipAddress = req.ip;

        // Verify MFA challenge
        const result = await mfaService.verifyChallengeSession(sessionToken, code, ipAddress);

        if (!result.verified) {
            // Log failed challenge
            await authAuditService.logEvent({
                eventType: 'mfa_challenge_failed',
                eventCategory: 'authentication',
                userId: result.userId,
                success: false,
                failureReason: result.error,
                ipAddress: ipAddress,
                userAgent: req.get('user-agent')
            });

            return res.fail(400, 'Verification failed', {
                message: result.error,
                attemptsRemaining: result.attemptsRemaining
            });
        }

        // MFA verified successfully
        let deviceFingerprint = null;
        if (trustDevice) {
            deviceFingerprint = await mfaService.trustDevice(
                result.userId,
                ipAddress,
                req.get('user-agent')
            );
        }

        // Log successful MFA verification
        await authAuditService.logEvent({
            eventType: 'mfa_verified',
            eventCategory: 'authentication',
            userId: result.userId,
            success: true,
            ipAddress: ipAddress,
            userAgent: req.get('user-agent'),
            metadata: {
                trustDevice: !!trustDevice,
                deviceFingerprint: deviceFingerprint
            }
        });

        res.json({
            message: 'MFA verification successful',
            verified: true,
            userId: result.userId,
            deviceTrusted: !!trustDevice
        });

    } catch (error) {
        console.error('MFA challenge verify error:', error);
        res.fail(500, 'Verification failed', {
            message: 'Unable to verify MFA challenge'
        });
    }
});

/**
 * POST /api/auth/mfa/disable
 * Disable MFA for account
 * Requires authentication + current password
 */
router.post('/mfa/disable', [
    authenticateToken,
    body('currentPassword')
        .notEmpty()
        .withMessage('Current password is required for security')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.fail(400, 'Validation failed', {
                message: 'Please check your input',
                details: errors.array()
            });
        }

        const userId = req.user.id;
        const email = req.user.email;
        const { currentPassword } = req.body;

        // Verify current password (import needed at top if not already)
        const { query } = require('../../config/database');
        const bcrypt = require('bcrypt');

        const users = await query(`
            SELECT password_hash FROM users WHERE id = ?
        `, [userId]);

        const isPasswordValid = await bcrypt.compare(currentPassword, users[0].password_hash);
        if (!isPasswordValid) {
            return res.fail(401, 'Invalid password', {
                message: 'Current password is incorrect'
            });
        }

        // Disable MFA
        await mfaService.disableMFA(userId);

        // Log MFA disabled event
        await authAuditService.logEvent({
            eventType: 'mfa_disabled',
            eventCategory: 'security',
            userId: userId,
            email: email,
            success: true,
            ipAddress: req.ip,
            userAgent: req.get('user-agent')
        });

        res.json({
            message: 'MFA successfully disabled',
            note: 'Two-factor authentication has been removed from your account'
        });

    } catch (error) {
        console.error('MFA disable error:', error);
        res.fail(500, 'Failed to disable MFA', {
            message: 'Unable to disable MFA'
        });
    }
});

/**
 * GET /api/auth/mfa/status
 * Get MFA status for current user
 * Requires authentication
 */
router.get('/mfa/status', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;

        const mfaEnabled = await mfaService.isMFAEnabled(userId);
        const remainingBackupCodes = mfaEnabled
            ? await mfaService.getRemainingBackupCodesCount(userId)
            : 0;

        res.json({
            mfaEnabled: mfaEnabled,
            method: req.user.mfa_method || null,
            remainingBackupCodes: remainingBackupCodes,
            note: mfaEnabled
                ? 'MFA is enabled for your account'
                : 'MFA is not enabled. Enable it for enhanced security.'
        });

    } catch (error) {
        console.error('MFA status error:', error);
        res.fail(500, 'Failed to get MFA status', {
            message: 'Unable to retrieve MFA status'
        });
    }
});

/**
 * POST /api/auth/mfa/backup-codes/regenerate
 * Regenerate backup codes
 * Requires authentication
 */
router.post('/mfa/backup-codes/regenerate', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;

        // Check if MFA is enabled
        const mfaEnabled = await mfaService.isMFAEnabled(userId);
        if (!mfaEnabled) {
            return res.fail(400, 'MFA not enabled', {
                message: 'MFA must be enabled to generate backup codes'
            });
        }

        // Generate new backup codes
        const backupCodes = await mfaService.generateBackupCodes(userId);

        // Log backup codes regeneration
        await authAuditService.logEvent({
            eventType: 'mfa_backup_codes_regenerated',
            eventCategory: 'security',
            userId: userId,
            email: req.user.email,
            success: true,
            ipAddress: req.ip,
            userAgent: req.get('user-agent')
        });

        res.json({
            message: 'Backup codes regenerated successfully',
            backupCodes: backupCodes,
            note: 'Previous backup codes are now invalid. Save these new codes securely.'
        });

    } catch (error) {
        console.error('Backup codes regenerate error:', error);
        res.fail(500, 'Failed to regenerate codes', {
            message: 'Unable to regenerate backup codes'
        });
    }
});

/**
 * GET /api/auth/mfa/trusted-devices
 * Get all trusted devices
 * Requires authentication
 */
router.get('/mfa/trusted-devices', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;

        const devices = await mfaService.getTrustedDevices(userId);

        res.json({
            message: 'Trusted devices retrieved successfully',
            devices: devices,
            count: devices.length
        });

    } catch (error) {
        console.error('Get trusted devices error:', error);
        res.fail(500, 'Failed to get devices', {
            message: 'Unable to retrieve trusted devices'
        });
    }
});

/**
 * DELETE /api/auth/mfa/trusted-devices/:deviceId
 * Revoke a trusted device
 * Requires authentication
 */
router.delete('/mfa/trusted-devices/:deviceId', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const deviceId = parseInt(req.params.deviceId);

        await mfaService.revokeTrustedDevice(deviceId, userId);

        // Log device revocation
        await authAuditService.logEvent({
            eventType: 'mfa_device_revoked',
            eventCategory: 'security',
            userId: userId,
            email: req.user.email,
            success: true,
            ipAddress: req.ip,
            userAgent: req.get('user-agent'),
            metadata: { deviceId: deviceId }
        });

        res.json({
            message: 'Trusted device revoked successfully',
            deviceId: deviceId
        });

    } catch (error) {
        console.error('Revoke trusted device error:', error);
        res.fail(500, 'Failed to revoke device', {
            message: 'Unable to revoke trusted device'
        });
    }
});

module.exports = router;
