/**
 * utils/helpers.js
 * Miscellaneous stateless utility functions.
 */

const https  = require('https');
const axios  = require('axios');
const logger = require('../logger');

/**
 * Fisher-Yates in-place shuffle. Returns the same array.
 */
function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

/**
 * Generate a short random room ID (base-36, 7 chars).
 */
function generateRoomId() {
    return Math.random().toString(36).substring(2, 9);
}

/**
 * Verify a Google reCAPTCHA v3 token.
 * Throws on failure — callers must handle the error.
 */
async function verifyRecaptcha(token) {
    if (process.env.ENABLE_RECAPTCHA !== 'true') {
        console.log('reCAPTCHA verification skipped (disabled in config)');
        return { success: true, score: 1.0 };
    }
    if (!token) {
        throw new Error('reCAPTCHA token required');
    }

    const secretKey = process.env.RECAPTCHA_SECRET_KEY;
    if (!secretKey) {
        console.warn('reCAPTCHA secret key not configured, skipping verification');
        return { success: true, score: 1.0 };
    }

    try {
        const response = await axios.post(
            'https://www.google.com/recaptcha/api/siteverify',
            null,
            {
                params: { secret: secretKey, response: token },
                httpsAgent: new https.Agent({ family: 4 }), // force IPv4
            }
        );

        logger.info('reCAPTCHA verification response:', response.data);

        if (!response.data.success) {
            console.warn('reCAPTCHA verification failed:', response.data['error-codes']);
            throw new Error('reCAPTCHA verification failed');
        }
        if (response.data.score !== undefined && response.data.score < 0.5) {
            logger.warn(`reCAPTCHA score too low: ${response.data.score}`);
            throw new Error('Bot activity suspected (low reCAPTCHA score)');
        }

        return { success: true, score: response.data.score };
    } catch (error) {
        logger.error('reCAPTCHA verification error:', { error });
        throw new Error('Verification service unavailable. Please try again later.');
    }
}

module.exports = { shuffleArray, generateRoomId, verifyRecaptcha };