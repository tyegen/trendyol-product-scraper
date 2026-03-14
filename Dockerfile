# Use the Apify Node.js image with embedded Playwright
# https://hub.docker.com/r/apify/actor-node-playwright-chrome
FROM apify/actor-node-playwright-chrome:20

# Copy package.json and install dependencies
COPY package*.json ./
RUN npm --quiet set progress=false \
 && npm install

# Copy the rest of the source code
COPY . ./

# Build the TypeScript project
RUN npm run build

# Remove devDependencies
RUN npm prune --omit=dev --omit=optional

# Run the project
CMD npm start
