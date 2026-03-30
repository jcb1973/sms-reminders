# 1. Use the ultra-lightweight Node.js Alpine image
FROM node:20-alpine

# 2. Create a directory for our app code inside the container
WORKDIR /usr/src/app

# 3. Copy 'package.json' and 'package-lock.json' first.
COPY package*.json ./

# 4. Install production dependencies only
RUN npm install --omit=dev

# 5. Copy the rest of your application code
COPY . .

# 6. Tell Docker which port the app listens on
EXPOSE 3000

# 7. The command to start your app
CMD [ "node", "index.js" ]
