-- Migration: 101_password_reset_system.sql
-- Add password reset/recovery system
-- Phase 1.2 of Authentication & Onboarding Implementation Plan

-- Create password reset tokens table
CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    email VARCHAR(255) NOT NULL,
    token_hash VARCHAR(64) NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    used_at TIMESTAMP NULL,
    ip_address VARCHAR(45),
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_user_id (user_id),
    INDEX idx_token_hash (token_hash),
    INDEX idx_email (email),
    INDEX idx_expires_at (expires_at),
    INDEX idx_used_at (used_at),
    INDEX idx_pending_resets (user_id, used_at, expires_at),

    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT = 'Password reset tokens. SHA-256 hashed, 1-hour expiry, one-time use.';

-- Add password change tracking to users table
SET @col_exists_password_changed = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'password_changed_at');

SET @sql_password_changed = IF(@col_exists_password_changed = 0,
    'ALTER TABLE users ADD COLUMN password_changed_at TIMESTAMP NULL AFTER updated_at',
    'SELECT "password_changed_at column already exists" AS message');
PREPARE stmt FROM @sql_password_changed;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Add last password reset request tracking
SET @col_exists_last_reset = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'last_password_reset_request');

SET @sql_last_reset = IF(@col_exists_last_reset = 0,
    'ALTER TABLE users ADD COLUMN last_password_reset_request TIMESTAMP NULL AFTER password_changed_at',
    'SELECT "last_password_reset_request column already exists" AS message');
PREPARE stmt FROM @sql_last_reset;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Create index for efficient token lookup
CREATE INDEX idx_active_reset_tokens
ON password_reset_tokens(token_hash, expires_at, used_at);
