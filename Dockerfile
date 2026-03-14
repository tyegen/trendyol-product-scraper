# Use the Apify Node.js image with embedded Playwright
# https://hub.docker.com/r/apify/actor-node-playwright-chrome
FROM apify/actor-node-playwright-chrome:18

# Copy package.json and install dependencies
COPY package*.json ./
RUN npm --quiet set progress=false \
 && npm install --omit=dev --omit=optional

# Copy the rest of the source code
COPY . ./

# Add package.json type
RUN echo '{"type": "module"}' > package.json.new && \
    jq -s '.[0] * .[1]' package.json package.json.new > package.json.tmp && \
    mv package.json.tmp package.json && \
    rm package.json.new

# Run the project
CMD npm start
