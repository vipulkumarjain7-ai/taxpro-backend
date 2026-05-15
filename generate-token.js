const jwt = require("jsonwebtoken");

// Use the same secret as in your backend .env file
const JWT_SECRET = "taxpro-super-secret-key";

const token = jwt.sign(
  {
    id: "admin-001",
    name: "Admin User",
    email: "admin@example.com",
    role: "admin"
  },
  JWT_SECRET,
  { expiresIn: "7d" }
);

console.log("\nJWT TOKEN:\n");
console.log(token);
console.log("\nCopy the token above and paste it into your frontend.\n");