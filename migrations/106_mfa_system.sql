-- Migration: 106_mfa_system.sql
-- Add Multi-Factor Authentication (MFA/2FA) system
-- Phase 1.7 of Authentication & Onboarding Implementation Plan
-- CRITICAL: Required for Stripe integration

-- Create MFA configurations table
CREATE TABLE IF NOT EXISTS mfa_configurations (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,

    -- MFA method and status
    method ENUM('totp', 'sms', 'email') DEFAULT 'totp' COMMENT 'TOTP (authenticator app), SMS, or email',
    enabled BOOLEAN DEFAULT FALSE,

    -- TOTP configuration
    secret VARCHAR(64) NOT NULL COMMENT 'Base32-encoded secret for TOTP',
    backup_codes_generated BOOLEAN DEFAULT FALSE,

    -- Verification tracking
    verified_at TIMESTAMP NULL COMMENT 'When MFA was first successfully verified',
    last_used_at TIMESTAMP NULL COMMENT 'Last successful MFA verification',
    failed_attempts INT DEFAULT 0 COMMENT 'Failed MFA attempts (reset on success)',

    -- Device trust (optional)
    allow_trusted_devices BOOLEAN DEFAULT TRUE,

    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    -- Indexes
    UNIQUE KEY unique_user_method (user_id, method),
    INDEX idx_user_id (user_id),
    INDEX idx_enabled (enabled),
    INDEX idx_verified_at (verified_at),

    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT = 'MFA configurations for users. Supports TOTP (authenticator apps), SMS, and email methods.';

-- Create MFA backup codes table
CREATE TABLE IF NOT EXISTS mfa_backup_codes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,

    -- Code details
    code_hash VARCHAR(64) NOT NULL COMMENT 'SHA-256 hash of backup code',
    used BOOLEAN DEFAULT FALSE,
    used_at TIMESTAMP NULL,
    used_ip_address VARCHAR(45) NULL,

    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- Indexes
    INDEX idx_user_id (user_id),
    INDEX idx_code_hash (code_hash),
    INDEX idx_used (used),

    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT = 'MFA backup/recovery codes (one-time use). Typically 10 codes generated per user.';

-- Create trusted devices table
CREATE TABLE IF NOT EXISTS mfa_trusted_devices (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,

    -- Device identification
    device_fingerprint VARCHAR(64) NOT NULL COMMENT 'Hash of IP + user agent + other factors',
    device_name VARCHAR(100) COMMENT 'User-friendly device name',
    device_info JSON COMMENT 'Browser, OS, device type',

    -- Trust details
    ip_address VARCHAR(45),
    user_agent TEXT,
    trusted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL COMMENT 'Trust expires after 30 days',

    -- Usage tracking
    last_used_at TIMESTAMP NULL,

    -- Revocation
    revoked BOOLEAN DEFAULT FALSE,
    revoked_at TIMESTAMP NULL,

    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    -- Indexes
    INDEX idx_user_id (user_id),
    INDEX idx_device_fingerprint (device_fingerprint),
    INDEX idx_expires_at (expires_at),
    INDEX idx_revoked (revoked),
    INDEX idx_user_fingerprint (user_id, device_fingerprint),

    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT = 'Trusted devices for MFA. Users can trust a device for 30 days to skip MFA challenges.';

-- Create MFA challenge sessions table (temporary tokens for 2-step verification)
CREATE TABLE IF NOT EXISTS mfa_challenge_sessions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,

    -- Session token
    session_token VARCHAR(64) NOT NULL COMMENT 'Temporary token for MFA challenge',

    -- Challenge details
    method ENUM('totp', 'sms', 'email', 'backup_code') NOT NULL,
    ip_address VARCHAR(45),
    user_agent TEXT,

    -- Status
    verified BOOLEAN DEFAULT FALSE,
    verified_at TIMESTAMP NULL,
    attempts INT DEFAULT 0 COMMENT 'Failed verification attempts',

    -- Expiry
    expires_at TIMESTAMP NOT NULL COMMENT '5-minute expiry for MFA challenge',

    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- Indexes
    UNIQUE KEY unique_session_token (session_token),
    INDEX idx_user_id (user_id),
    INDEX idx_expires_at (expires_at),
    INDEX idx_verified (verified),

    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT = 'Temporary MFA challenge sessions. Created after successful password verification, expires in 5 minutes.';

-- Add MFA status columns to users table
SET @col_exists_mfa_enabled = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'mfa_enabled');

SET @sql_mfa_enabled = IF(@col_exists_mfa_enabled = 0,
    'ALTER TABLE users ADD COLUMN mfa_enabled BOOLEAN DEFAULT FALSE AFTER email_verified_at',
    'SELECT "mfa_enabled column already exists" AS message');
PREPARE stmt FROM @sql_mfa_enabled;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists_mfa_enabled_at = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'mfa_enabled_at');

SET @sql_mfa_enabled_at = IF(@col_exists_mfa_enabled_at = 0,
    'ALTER TABLE users ADD COLUMN mfa_enabled_at TIMESTAMP NULL AFTER mfa_enabled',
    'SELECT "mfa_enabled_at column already exists" AS message');
PREPARE stmt FROM @sql_mfa_enabled_at;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists_mfa_method = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'mfa_method');

SET @sql_mfa_method = IF(@col_exists_mfa_method = 0,
    'ALTER TABLE users ADD COLUMN mfa_method VARCHAR(20) NULL COMMENT ''Primary MFA method (totp, sms, email)'' AFTER mfa_enabled_at',
    'SELECT "mfa_method column already exists" AS message');
PREPARE stmt FROM @sql_mfa_method;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Create index for MFA-enabled users
CREATE INDEX idx_mfa_enabled ON users(mfa_enabled, id);

-- Add comments for documentation
ALTER TABLE mfa_configurations
COMMENT = 'MFA configurations. Supports TOTP (Google Authenticator, Authy), SMS, and email. CRITICAL for Stripe integration.';

ALTER TABLE mfa_backup_codes
COMMENT = 'MFA backup codes (one-time use). 10 codes per user. Hashed with SHA-256 before storage.';

ALTER TABLE mfa_trusted_devices
COMMENT = 'Trusted devices. Users can skip MFA for 30 days on trusted devices. Improves UX while maintaining security.';

ALTER TABLE mfa_challenge_sessions
COMMENT = 'Temporary MFA challenge sessions. 5-minute expiry. Created after password verification, before MFA verification.';
