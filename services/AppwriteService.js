const { Client, Account, Users, ID, Query } = require('node-appwrite');

/**
 * Appwrite Service for Phoenix4ge
 * Handles authentication via Appwrite while maintaining Phoenix4ge's business logic
 */
class AppwriteService {
    constructor() {
        // Server-side client (for admin operations)
        this.client = new Client()
            .setEndpoint(process.env.APPWRITE_ENDPOINT)
            .setProject(process.env.APPWRITE_PROJECT_ID)
            .setKey(process.env.APPWRITE_API_KEY);

        this.users = new Users(this.client);
        this.account = new Account(this.client);
    }

    /**
     * Create a new user in Appwrite
     * @param {string} email - User email
     * @param {string} password - User password
     * @param {string} name - User name
     * @returns {Promise<Object>} Appwrite user object
     */
    async createUser(email, password, name) {
        try {
            const user = await this.users.create(
                ID.unique(),
                email,
                undefined, // phone (optional)
                password,
                name
            );
            return { success: true, user };
        } catch (error) {
            console.error('Appwrite createUser error:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Create email session (login)
     * Note: This creates a session on the server side, which isn't ideal for web apps.
     * In production, the frontend should handle session creation directly.
     * @param {string} email - User email
     * @param {string} password - User password
     * @returns {Promise<Object>} Session object
     */
    async createEmailSession(email, password) {
        try {
            const session = await this.account.createEmailPasswordSession(email, password);
            return { success: true, session };
        } catch (error) {
            console.error('Appwrite createEmailSession error:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Get user by email
     * @param {string} email - User email
     * @returns {Promise<Object|null>} User object or null
     */
    async getUserByEmail(email) {
        try {
            const response = await this.users.list([
                Query.equal('email', email)
            ]);

            if (response.users && response.users.length > 0) {
                return response.users[0];
            }
            return null;
        } catch (error) {
            console.error('Appwrite getUserByEmail error:', error);
            return null;
        }
    }

    /**
     * Get user by ID
     * @param {string} userId - Appwrite user ID
     * @returns {Promise<Object|null>} User object or null
     */
    async getUserById(userId) {
        try {
            const user = await this.users.get(userId);
            return user;
        } catch (error) {
            console.error('Appwrite getUserById error:', error);
            return null;
        }
    }

    /**
     * Update user password
     * @param {string} userId - Appwrite user ID
     * @param {string} newPassword - New password
     * @returns {Promise<Object>} Result object
     */
    async updateUserPassword(userId, newPassword) {
        try {
            await this.users.updatePassword(userId, newPassword);
            return { success: true };
        } catch (error) {
            console.error('Appwrite updateUserPassword error:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Delete user
     * @param {string} userId - Appwrite user ID
     * @returns {Promise<Object>} Result object
     */
    async deleteUser(userId) {
        try {
            await this.users.delete(userId);
            return { success: true };
        } catch (error) {
            console.error('Appwrite deleteUser error:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Verify session token (JWT)
     * Note: In a production app, you'd want to verify the JWT token from the client
     * @param {string} sessionId - Session ID to verify
     * @returns {Promise<Object>} Verification result
     */
    async verifySession(sessionId) {
        try {
            // This is a simplified version - in production you'd verify the JWT properly
            const session = await this.account.getSession(sessionId);
            return { success: true, session };
        } catch (error) {
            console.error('Appwrite verifySession error:', error);
            return { success: false, error: error.message };
        }
    }
}

// Export singleton instance
module.exports = new AppwriteService();
