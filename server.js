const https = require('https');
const express = require('express');
const schedule = require('node-schedule');
const sgMail = require('@sendgrid/mail');
const fs = require('fs').promises;
const path = require('path');

const app = express();

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, 'public')));

// SendGrid API Key (set in environment variables)
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Your email address (set in environment variables)
const YOUR_EMAIL = process.env.YOUR_EMAIL || 'your-email@example.com';

// Path to store stock data
const STOCK_FILE = path.join(__dirname, 'stockData.json');

// HTTP request options for growagarden.gg
const options = {
  method: 'GET',
  hostname: 'growagarden.gg',
  path: '/stocks?_rsc=14g5d',
  headers: {
    accept: '*/*',
    'accept-language': 'en-US,en;q=0.9',
    'next-router-state-tree':
      '%5B%22%22%2C%7B%22children%22%3A%5B%22stocks%22%2C%7B%22children%22%3A%5B%22__PAGE__%22%2C%7B%7D%2C%22%2Fstocks%22%2C%22refresh%22%5D%7D%5D%7D%2Cnull%2C%22refetch%22%5D',
    priority: 'u=1, i',
    referer: 'https://growagarden.gg/stocks',
    rsc: '1',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 OPR/119.0.0.0',
    'Content-Length': '0',
  },
};

// Function to extract JSON from response text
function extractJSONFromText(text, key) {
  const keyPos = text.indexOf(`"${key}"`);
  if (keyPos === -1) return null;

  const colonPos = text.indexOf(':', keyPos);
  if (colonPos === -1) return null;

  const startPos = text.indexOf('{', colonPos);
  if (startPos === -1) return null;

  let bracketCount = 0;
  let endPos = startPos;

  for (let i = startPos; i < text.length; i++) {
    if (text[i] === '{') bracketCount++;
    else if (text[i] === '}') bracketCount--;

    if (bracketCount === 0) {
      endPos = i;
      break;
    }
  }

  if (bracketCount !== 0) return null;

  return text.slice(startPos, endPos + 1);
}

// Function to fetch stock data
function fetchStockData() {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        const jsonString = extractJSONFromText(data, 'stockDataSSR');
        if (!jsonString) {
          return reject(new Error('stockDataSSR not found'));
        }

        try {
          const stockDataSSR = JSON.parse(jsonString);
          resolve(stockDataSSR);
        } catch (e) {
          reject(new Error('Failed to parse extracted JSON: ' + e.message));
        }
      });
    });

    req.on('error', (e) => {
      reject(e);
    });

    req.end();
  });
}

// Function to load previous stock data
async function loadPreviousStock() {
  try {
    const data = await fs.readFile(STOCK_FILE, 'utf8');
    return JSON.parse(data);
  } catch (e) {
    return null; // Return null if file doesn't exist or is invalid
  }
}

// Function to save current stock data
async function saveStockData(data) {
  await fs.writeFile(STOCK_FILE, JSON.stringify(data, null, 2));
}

// Function to send email
async function sendEmail(subject, changes) {
  const msg = {
    to: YOUR_EMAIL,
    from: YOUR_EMAIL, // Use verified sender email
    subject: subject,
    text: `Stock update:\n\n${changes.join('\n')}`,
    html: `<p>Stock update:</p><ul>${changes.map((change) => `<li>${change}</li>`).join('')}</ul>`,
  };

  try {
    await sgMail.send(msg);
    console.log('Email sent successfully');
    return true;
  } catch (error) {
    console.error('Error sending email:', error);
    return false;
  }
}

// Function to compare stock and detect changes
async function checkStockChanges() {
  try {
    const currentStock = await fetchStockData();
    const previousStock = await loadPreviousStock();

    const changes = [];

    // Assuming stockDataSSR is an array of items with id, name, and inStock
    if (!previousStock) {
      // First run, notify about all in-stock items
      currentStock.forEach((item) => {
        if (item.inStock) {
          changes.push(`${item.name} is in stock (New Item)`);
        }
      });
    } else {
      // Compare with previous stock
      currentStock.forEach((currentItem) => {
        const previousItem = previousStock.find((p) => p.id === currentItem.id);
        if (!previousItem) {
          // New item added
          changes.push(`${currentItem.name} was added to stock`);
        } else if (!previousItem.inStock && currentItem.inStock) {
          // Item restocked
          changes.push(`${currentItem.name} is back in stock`);
        }
      });
    }

    if (changes.length > 0) {
      await sendEmail('GrowAGarden Stock Update', changes);
    }

    // Save current stock for next comparison
    await saveStockData(currentStock);
    return { success: true, changes };
  } catch (error) {
    console.error('Error checking stock:', error);
    await sendEmail('Stock Check Error', [`Error checking stock: ${error.message}`]);
    return { success: false, error: error.message };
  }
}

// Function to get current stock and email it
async function getCurrentStock() {
  try {
    const currentStock = await fetchStockData();
    const stockList = currentStock.map((item) => 
      `${item.name}: ${item.inStock ? 'In Stock' : 'Out of Stock'}`
    );
    await sendEmail('Current GrowAGarden Stock', stockList.length > 0 ? stockList : ['No stock data available']);
    return { success: true, stock: stockList };
  } catch (error) {
    console.error('Error fetching current stock:', error);
    await sendEmail('Current Stock Error', [`Error fetching stock: ${error.message}`]);
    return { success: false, error: error.message };
  }
}

// Schedule stock check every 10 minutes
schedule.scheduleJob('*/10 * * * *', checkStockChanges);

// API endpoint for manual stock check
app.get('/api/stock/check', async (req, res) => {
  const result = await checkStockChanges();
  res.json(result);
});

// API endpoint for getting current stock
app.get('/api/stock/get', async (req, res) => {
  const result = await getCurrentStock();
  res.json(result);
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  // Run initial stock check
  checkStockChanges();
});
