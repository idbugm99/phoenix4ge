-- Migration: 100_email_verification_system.sql
-- Add email verification system for user registration
-- Phase 1.1 of Authentication & Onboarding Implementation Plan

-- Add email verification columns to users table (check if columns exist first)
SET @col_exists_verified = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'email_verified');
SET @col_exists_verified_at = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'email_verified_at');

SET @sql_verified = IF(@col_exists_verified = 0,
    'ALTER TABLE users ADD COLUMN email_verified BOOLEAN DEFAULT FALSE AFTER is_active',
    'SELECT "email_verified column already exists" AS message');
PREPARE stmt FROM @sql_verified;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql_verified_at = IF(@col_exists_verified_at = 0,
    'ALTER TABLE users ADD COLUMN email_verified_at TIMESTAMP NULL AFTER email_verified',
    'SELECT "email_verified_at column already exists" AS message');
PREPARE stmt FROM @sql_verified_at;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Create email verification tokens table
CREATE TABLE IF NOT EXISTS email_verifications (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    email VARCHAR(255) NOT NULL,
    token_hash VARCHAR(64) NOT NULL,
    token_type ENUM('verification', 'change_email') DEFAULT 'verification',
    expires_at TIMESTAMP NOT NULL,
    verified_at TIMESTAMP NULL,
    ip_address VARCHAR(45),
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_user_id (user_id),
    INDEX idx_token_hash (token_hash),
    INDEX idx_email (email),
    INDEX idx_expires_at (expires_at),
    INDEX idx_verified_at (verified_at),

    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Create index for finding pending verifications
CREATE INDEX idx_pending_verification
ON email_verifications(user_id, verified_at, expires_at);

-- Update existing users to be verified (for backward compatibility)
-- New users will default to email_verified = FALSE
UPDATE users SET email_verified = TRUE, email_verified_at = created_at
WHERE email_verified IS NULL OR email_verified = FALSE;

-- Add comment to document the system
ALTER TABLE email_verifications
COMMENT = 'Stores email verification tokens for user registration and email changes. Tokens are SHA-256 hashed before storage.';
