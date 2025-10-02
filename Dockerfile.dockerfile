FROM node:18-alpine

# Create app directory
WORKDIR /app

# Copy files
COPY package*.json ./
RUN npm install --production

COPY . .

# Expose port
EXPOSE 3000

# Run the app
CMD ["npm", "start"]
