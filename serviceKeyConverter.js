const fs = require('fs');

const jsonData = fs.readFileSync('./serviceAccountKey.json', 'utf8');
const base64String = Buffer.from(jsonData).toString('base64');

console.log('\n=== COPY THIS BASE64 STRING ===\n');
console.log(base64String);
console.log('\n=== END OF BASE64 STRING ===\n');
console.log('Add this as FIREBASE_SERVICE_ACCOUNT in Render environment variables');