const { Sequelize, DataTypes } = require('sequelize');
const sequelize = require('../db');
const User = require('./User'); // <-- to see which user a review belongs to.
const Product = require('./Product'); // <-- to see which product is being reviewed.

const Review = sequelize.define('Review', {
    productId: {  // <-- para asociar review a producto.
        type: DataTypes.INTEGER,
        allowNull: false
    },

    userId: { // <-- para asociar a usuario especifico el cual escribio la review.
        type: DataTypes.INTEGER,
        allowNull: false
    },
    reviewDate: { // <-- fecha de cuando la review fue escrita.
        type: DataTypes.DATEONLY,
        allowNull: false,
        defaultValue: DataTypes.NOW
    },
    review: {
        type: DataTypes.TEXT,
        allowNull: false
    },
    // rating, luego en las rutas se agregara logica para que sea entre 1 y 5, debe ser un float.
    rating: {
        type: DataTypes.FLOAT,
        allowNull: true
    }
});

Review.beforeDestroy(async (instance, options) => {
    try {
        await sequelize.models.Review.destroy({ where: { productId: instance.productId }});
        
    } catch (error) {
        console.error(`Error deleting related reviews for product: ${error}`);
    }
});

// Inside associations.js or in the Review model file

Review.associate = (models) => {
    // Define associations here
    Review.belongsTo(models.User, { foreignKey: 'userId' }); // One-to-many with User
    Review.belongsTo(models.Product, { foreignKey: 'productId' }); // One-to-many with Product
};



// associations.js 
/*
Review.associate = (models) => {
    Review.belongsToMany(models.Product, {through: 'ProductReview'})
}
*/

// one to many with user
// many to many with Product.


module.exports = Review;
