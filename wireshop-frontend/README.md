# Wireshop Frontend

Frontend for the Wireshop application, providing user interfaces for dashboard, admin views, catalog, and more. Built with vanilla HTML, CSS, and JavaScript.

## Tech Stack
- HTML5
- CSS3
- JavaScript (ES6+)
- Assets: Includes images like czm-logo.png for branding

## Installation
1. Clone the repo: `git clone https://github.com/Syaroli/wireshop-frontend.git`
2. Open `index.html` in your browser to view locally (no build step needed for now).
3. For development, use a local server like Live Server in VS Code or `npx http-server` for hot reloading.

## Features
- **index.html**: Landing page with basic navigation and logo.
- **dashboard.html**: Main dashboard for summaries and links.
- **admin.html**: Admin panel for live technician activity monitoring.
- **catalog.js**: Handles catalog/inventory display logic.
- **users.js**: User-related functions (e.g., authentication or profiles).
- **script.js**: Global scripts for API calls and DOM manipulation.
- **style.css**: Site-wide styling.

## Integration with Backend
- Fetches data from the backend API (e.g., via `fetch()` in script.js).
- Example: Connect to backend endpoints like `/users` or `/catalog` at `http://localhost:3000` (update base URL as needed).

## Development
- Environment: No dependencies required, but consider adding tools like ESLint for JS linting.
- Run locally: Open files in a browser or use a dev server.
- Testing: Manually test pages or add simple JS unit tests.

## Contributing
Pull requests welcome! See issues for open tasks.
