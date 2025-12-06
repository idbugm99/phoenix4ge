-- Migration: 107_oauth_system.sql
-- Add OAuth/Social Login system (Google, Facebook, Apple)
-- Phase 1.8 of Authentication & Onboarding Implementation Plan
-- Enables social login and account linking

-- Create OAuth providers table (for admin configuration)
CREATE TABLE IF NOT EXISTS oauth_providers (
    id INT AUTO_INCREMENT PRIMARY KEY,

    -- Provider details
    provider VARCHAR(50) NOT NULL UNIQUE COMMENT 'google, facebook, apple, github, twitter',
    provider_name VARCHAR(100) NOT NULL COMMENT 'Display name: Google, Facebook, etc',

    -- Configuration
    enabled BOOLEAN DEFAULT FALSE,
    client_id VARCHAR(255),
    client_secret VARCHAR(255) COMMENT 'Encrypted in production',

    -- OAuth endpoints (for custom providers)
    authorize_url VARCHAR(500),
    token_url VARCHAR(500),
    user_info_url VARCHAR(500),

    -- Settings
    scope TEXT COMMENT 'Comma-separated OAuth scopes',
    allow_signup BOOLEAN DEFAULT TRUE COMMENT 'Allow new user registration via OAuth',
    require_email_verification BOOLEAN DEFAULT FALSE COMMENT 'Require email verification for OAuth users',

    -- Statistics
    total_connections INT DEFAULT 0,
    total_signups INT DEFAULT 0,

    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    INDEX idx_provider (provider),
    INDEX idx_enabled (enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT = 'OAuth provider configurations (Google, Facebook, Apple). Admin configures client IDs and secrets.';

-- Create OAuth linked accounts table
CREATE TABLE IF NOT EXISTS oauth_accounts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,

    -- Provider details
    provider VARCHAR(50) NOT NULL COMMENT 'google, facebook, apple',
    provider_user_id VARCHAR(255) NOT NULL COMMENT 'User ID from OAuth provider',

    -- User info from provider
    provider_email VARCHAR(255),
    provider_name VARCHAR(255),
    provider_avatar_url VARCHAR(500),

    -- OAuth tokens (optional - for API access)
    access_token TEXT COMMENT 'OAuth access token (encrypted)',
    refresh_token TEXT COMMENT 'OAuth refresh token (encrypted)',
    token_expires_at TIMESTAMP NULL COMMENT 'Access token expiry',

    -- Metadata
    raw_profile JSON COMMENT 'Full profile data from provider',

    -- Linking details
    linked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_used_at TIMESTAMP NULL,

    -- Status
    is_primary BOOLEAN DEFAULT FALSE COMMENT 'Primary OAuth method for this user',
    revoked BOOLEAN DEFAULT FALSE,
    revoked_at TIMESTAMP NULL,

    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    -- Indexes
    UNIQUE KEY unique_provider_user (provider, provider_user_id),
    INDEX idx_user_id (user_id),
    INDEX idx_provider (provider),
    INDEX idx_provider_email (provider_email),
    INDEX idx_revoked (revoked),
    INDEX idx_user_provider (user_id, provider),

    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT = 'OAuth linked accounts. Users can link multiple providers (Google + Facebook + Apple).';

-- Create OAuth state tokens table (for CSRF protection)
CREATE TABLE IF NOT EXISTS oauth_state_tokens (
    id INT AUTO_INCREMENT PRIMARY KEY,

    -- State token
    state_token VARCHAR(64) NOT NULL UNIQUE COMMENT 'Random state token for CSRF protection',

    -- OAuth flow details
    provider VARCHAR(50) NOT NULL,
    action VARCHAR(20) NOT NULL COMMENT 'login, signup, link',

    -- User context (if authenticated)
    user_id INT NULL COMMENT 'Null for signup/login, set for account linking',

    -- Request context
    ip_address VARCHAR(45),
    user_agent TEXT,
    return_url VARCHAR(500) COMMENT 'URL to redirect after OAuth',

    -- Expiry
    expires_at TIMESTAMP NOT NULL COMMENT '10-minute expiry',
    used BOOLEAN DEFAULT FALSE,
    used_at TIMESTAMP NULL,

    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- Indexes
    INDEX idx_state_token (state_token),
    INDEX idx_expires_at (expires_at),
    INDEX idx_used (used),

    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT = 'OAuth state tokens for CSRF protection. 10-minute expiry, single-use.';

-- Add OAuth-related columns to users table
SET @col_exists_oauth_signup = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'oauth_signup');

SET @sql_oauth_signup = IF(@col_exists_oauth_signup = 0,
    'ALTER TABLE users ADD COLUMN oauth_signup BOOLEAN DEFAULT FALSE COMMENT ''User signed up via OAuth'' AFTER mfa_method',
    'SELECT "oauth_signup column already exists" AS message');
PREPARE stmt FROM @sql_oauth_signup;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists_oauth_primary_provider = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'oauth_primary_provider');

SET @sql_oauth_primary = IF(@col_exists_oauth_primary_provider = 0,
    'ALTER TABLE users ADD COLUMN oauth_primary_provider VARCHAR(50) NULL COMMENT ''Primary OAuth provider (google, facebook, apple)'' AFTER oauth_signup',
    'SELECT "oauth_primary_provider column already exists" AS message');
PREPARE stmt FROM @sql_oauth_primary;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Insert default OAuth provider configurations (disabled by default)
INSERT IGNORE INTO oauth_providers (provider, provider_name, enabled, scope, allow_signup) VALUES
('google', 'Google', FALSE, 'openid,profile,email', TRUE),
('facebook', 'Facebook', FALSE, 'email,public_profile', TRUE),
('apple', 'Apple', FALSE, 'name,email', TRUE);

-- Add comments for documentation
ALTER TABLE oauth_providers
COMMENT = 'OAuth provider configs. Admin must add client_id/client_secret. Supports Google, Facebook, Apple, and custom providers.';

ALTER TABLE oauth_accounts
COMMENT = 'Linked OAuth accounts. Users can have multiple providers. Tokens stored encrypted for API access.';

ALTER TABLE oauth_state_tokens
COMMENT = 'CSRF protection tokens. 10-minute expiry, single-use. Prevents OAuth hijacking attacks.';
