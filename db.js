const { Sequelize } = require("sequelize");

const sequelize = new Sequelize("edubridge", "root", "", {
  host: "localhost",
  dialect: "mysql",
  logging: false,
});

module.exports = sequelize;
