// hash-generator.js
const bcrypt = require('bcrypt');

const password = 'supersecret'; // your plaintext password
const saltRounds = 10; // Adjust cost factor as needed

bcrypt.hash(password, saltRounds, (err, hash) => {
  if (err) {
    console.error('Error hashing password:', err);
  } else {
    console.log('Hashed password:', hash);
    // Copy the hash and save it in your credentials file
  }
});
