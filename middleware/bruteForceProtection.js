const loginAttemptService = require('../src/services/LoginAttemptService');

/**
 * Brute Force Protection Middleware
 *
 * Features:
 * - Check account lockout status before login attempt
 * - IP-based rate limiting for distributed attacks
 * - Clear error messages with lockout time remaining
 * - Prevents enumeration by checking both user and IP limits
 *
 * Progressive Lockout:
 * - 5 failed attempts → 15 minutes
 * - 10 failed attempts → 1 hour
 * - 15 failed attempts → 24 hours
 */

/**
 * Check if account or IP is locked/rate limited
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Next middleware function
 */
async function checkBruteForce(req, res, next) {
    try {
        const { email } = req.body;
        const ipAddress = req.ip;

        // Check account lockout
        if (email) {
            const lockoutStatus = await loginAttemptService.checkAccountLockout(email);

            if (lockoutStatus.locked) {
                const minutesRemaining = Math.ceil(
                    (lockoutStatus.lockedUntil - new Date()) / (1000 * 60)
                );

                return res.fail(429, 'Account locked', {
                    message: `Too many failed login attempts. Account is locked for ${minutesRemaining} more minute(s).`,
                    lockedUntil: lockoutStatus.lockedUntil,
                    attempts: lockoutStatus.attempts,
                    minutesRemaining: minutesRemaining
                });
            }
        }

        // Check IP-based rate limiting (prevents distributed attacks)
        const recentIPFailures = await loginAttemptService.getRecentFailedAttemptsByIP(ipAddress, 30);

        if (recentIPFailures >= 20) {
            return res.fail(429, 'Too many requests', {
                message: 'Too many failed login attempts from this IP address. Please try again later.',
                note: 'Multiple accounts have been targeted from your IP address'
            });
        }

        // If we reach here, allow the request to proceed
        next();

    } catch (error) {
        console.error('Brute force protection error:', error);
        // Don't block login on middleware errors
        next();
    }
}

/**
 * Rate limit middleware for password reset requests
 * Prevents abuse of password reset system
 */
async function checkPasswordResetRateLimit(req, res, next) {
    try {
        const { email } = req.body;
        const ipAddress = req.ip;

        // Check email-based rate limiting (5 requests per hour)
        if (email) {
            const recentRequests = await loginAttemptService.getRecentFailedAttempts(email, 60);
            if (recentRequests >= 5) {
                return res.fail(429, 'Too many requests', {
                    message: 'Too many password reset requests. Please try again in an hour.',
                    note: 'Rate limit: 5 requests per hour per email'
                });
            }
        }

        // Check IP-based rate limiting (20 requests per hour)
        const recentIPRequests = await loginAttemptService.getRecentFailedAttemptsByIP(ipAddress, 60);
        if (recentIPRequests >= 20) {
            return res.fail(429, 'Too many requests', {
                message: 'Too many password reset requests from this IP address. Please try again later.',
                note: 'Rate limit: 20 requests per hour per IP'
            });
        }

        next();

    } catch (error) {
        console.error('Password reset rate limit error:', error);
        // Don't block request on middleware errors
        next();
    }
}

/**
 * Generic rate limiter for any authentication endpoint
 * @param {number} maxRequests - Maximum requests per window
 * @param {number} windowMinutes - Time window in minutes
 * @param {string} identifier - What to rate limit by ('ip', 'email', 'both')
 * @returns {Function} Middleware function
 */
function createRateLimiter(maxRequests = 10, windowMinutes = 15, identifier = 'ip') {
    return async (req, res, next) => {
        try {
            const ipAddress = req.ip;
            const email = req.body.email || req.user?.email;

            let exceeded = false;

            if (identifier === 'ip' || identifier === 'both') {
                const ipRequests = await loginAttemptService.getRecentFailedAttemptsByIP(ipAddress, windowMinutes);
                if (ipRequests >= maxRequests) {
                    exceeded = true;
                }
            }

            if ((identifier === 'email' || identifier === 'both') && email) {
                const emailRequests = await loginAttemptService.getRecentFailedAttempts(email, windowMinutes);
                if (emailRequests >= maxRequests) {
                    exceeded = true;
                }
            }

            if (exceeded) {
                return res.fail(429, 'Rate limit exceeded', {
                    message: `Too many requests. Please try again in ${windowMinutes} minute(s).`,
                    limit: maxRequests,
                    window: windowMinutes
                });
            }

            next();

        } catch (error) {
            console.error('Rate limiter error:', error);
            // Don't block request on middleware errors
            next();
        }
    };
}

module.exports = {
    checkBruteForce,
    checkPasswordResetRateLimit,
    createRateLimiter
};
