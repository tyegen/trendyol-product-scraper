# Use the Apify Node.js image with embedded Playwright
# https://hub.docker.com/r/apify/actor-node-playwright-chrome
FROM apify/actor-node-playwright-chrome:18

# Copy package.json and install dependencies
COPY package*.json ./
RUN npm --quiet set progress=false \
 && npm install --omit=dev --omit=optional

# Copy the rest of the source code
COPY . ./


# Run the project
CMD npm start
