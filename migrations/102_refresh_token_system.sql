-- Migration: 102_refresh_token_system.sql
-- Add refresh token system for secure, long-lived sessions
-- Phase 1.3 of Authentication & Onboarding Implementation Plan
-- Architecture: 15-minute access tokens + 30-day refresh tokens

-- Create refresh tokens table
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    token_hash VARCHAR(64) NOT NULL UNIQUE,

    -- Token metadata
    expires_at TIMESTAMP NOT NULL,
    revoked_at TIMESTAMP NULL,
    replaced_by_token_hash VARCHAR(64) NULL COMMENT 'For token rotation tracking',

    -- Device/session tracking
    device_info JSON COMMENT 'Browser, OS, device type',
    ip_address VARCHAR(45),
    user_agent TEXT,

    -- Security
    last_used_at TIMESTAMP NULL,
    usage_count INT DEFAULT 0,
    max_usage INT DEFAULT 1 COMMENT 'For rotating refresh tokens (1=one-time use)',

    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    -- Indexes
    INDEX idx_user_id (user_id),
    INDEX idx_token_hash (token_hash),
    INDEX idx_expires_at (expires_at),
    INDEX idx_revoked_at (revoked_at),
    INDEX idx_active_tokens (user_id, expires_at, revoked_at),
    INDEX idx_device_tracking (user_id, ip_address, created_at),

    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT = 'Refresh tokens for secure session management. Tokens rotate on use (sliding expiration).';

-- Add refresh token tracking to users table
SET @col_exists_token_version = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'token_version');

SET @sql_token_version = IF(@col_exists_token_version = 0,
    'ALTER TABLE users ADD COLUMN token_version INT DEFAULT 1 AFTER last_password_reset_request',
    'SELECT "token_version column already exists" AS message');
PREPARE stmt FROM @sql_token_version;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Create composite index for efficient cleanup
CREATE INDEX idx_expired_tokens
ON refresh_tokens(expires_at, revoked_at);

-- Add comment for documentation
ALTER TABLE refresh_tokens
COMMENT = 'Refresh tokens with automatic rotation. Each use generates a new token. Max age: 30 days. Access tokens: 15 minutes.';
