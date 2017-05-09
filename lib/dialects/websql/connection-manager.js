'use strict';

const AbstractConnectionManager = require('../abstract/connection-manager');
const Promise = require('../../promise');
const Utils = require('../../utils');
const debug = Utils.getLogger().debugContext('connection:websql');
const dataTypes = require('../../data-types').websql;
const sequelizeErrors = require('../../errors');
const parserStore = require('../parserStore')('websql');

class ConnectionManager extends AbstractConnectionManager {
  constructor(dialect, sequelize) {
    super(dialect, sequelize);
    this.sequelize = sequelize;
    this.config = sequelize.config;
    this.dialect = dialect;
    this.dialectName = this.sequelize.options.dialect;
    this.connections = {};

    try {
      if (!sequelize.config.database || typeof(sequelize.config.database.transaction) !== "function")
        throw new Error("Please specify database instance in config");
    } catch (err) {
      throw err;
    }

    this.refreshTypeParser(dataTypes);
  }

  // Expose this as a method so that the parsing may be updated when the user has added additional, custom types
  _refreshTypeParser(dataType) {
    parserStore.refresh(dataType);
  }

  _clearTypeParser() {
    parserStore.clear();
  }

  getConnection(options) {
    return Promise.resolve(this.config.database);
  }

  releaseConnection(connection, force) {

  }
}


module.exports = ConnectionManager;
module.exports.ConnectionManager = ConnectionManager;
module.exports.default = ConnectionManager;
