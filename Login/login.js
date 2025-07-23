    export default {
      async fetch(request, env, ctx) {
        if (request.method === 'POST' && request.url.includes('/login')) {
          // Handle login logic here (verify credentials, create session)
          // Example (replace with actual implementation):
          const formData = await request.formData();
          const username = formData.get('username');
          const password = formData.get('password');

          if (username === 'test' && password === 'password') {
            // Create a JWT or cookie here
            const sessionToken = 'some_token';
            return new Response(null, {
              status: 302,
              headers: {
                'Location': '/',
                'Set-Cookie': `session=${sessionToken}; HttpOnly; Path=/; Secure`, // Example cookie setup
              },
            });
          } else {
            return new Response('Unauthorized', { status: 401 });
          }
        }
        return new Response('Not Found', { status: 404 });
      },
    };