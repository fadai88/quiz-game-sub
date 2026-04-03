        const socket = io();

        document.getElementById('registrationForm').addEventListener('submit', (event) => {
            event.preventDefault();
            const username = document.getElementById('regUsername').value;
            const email = document.getElementById('regEmail').value;
            const password = document.getElementById('regPassword').value;

            // Generate reCAPTCHA token
            grecaptcha.execute('6LeDS1IqAAAAAMx338dPnRkVkj75ggf6Yq4OYu8i', { action: 'register' }).then((token) => {
                console.log('Generated token:', token); // Check if token is generated
                socket.emit('register', { username, email, password, token }); // Send token
            });
        });

        socket.on('registrationSuccess', () => {
            document.getElementById('registrationMessage').textContent = 'Registration successful! Please check your email to verify your account.';
        });

        socket.on('registrationFailure', (message) => {
            document.getElementById('registrationMessage').textContent = `Registration failed: ${message}`;
        });
