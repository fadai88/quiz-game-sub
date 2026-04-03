        // Make reCAPTCHA optional - will be fetched from server config
        window.recaptchaEnabled = false; // Default to false, will be updated by server
        window.recaptchaSiteKey = "6LeDS1IqAAAAAMx338dPnRkVkj75ggf6Yq4OYu8i";
        console.log("reCAPTCHA config (initial):", { enabled: window.recaptchaEnabled, siteKey: window.recaptchaSiteKey });
