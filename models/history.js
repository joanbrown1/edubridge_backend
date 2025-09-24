const { DataTypes } = require("sequelize");
const sequelize = require("../db");
const User = require("./user");

const History = sequelize.define("History", {
  summary: { type: DataTypes.TEXT, allowNull: false },
  quiz: { type: DataTypes.JSON, allowNull: false },
  flashcards: { type: DataTypes.JSON, allowNull: false },
  originalText: { type: DataTypes.TEXT, allowNull: false },
  level: { type: DataTypes.STRING },
});

User.hasMany(History, { foreignKey: "userId" });
History.belongsTo(User, { foreignKey: "userId" });

module.exports = History;
