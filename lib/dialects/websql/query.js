'use strict';

var Utils = require('../../utils')
  , _ = require('lodash')
  , Promise = require('../../promise')
  , AbstractQuery = require('../abstract/query')
  , QueryTypes = require('../../query-types')
  , sequelizeErrors = require('../../errors.js')
  , parserStore = require('../parserStore')('websql');

var Query = function(database, sequelize, options) {
  this.database = database;
  this.sequelize = sequelize;
  this.instance = options.instance;
  this.model = options.model;
  this.options = _.extend({
    logging: console.log,
    plain: false,
    raw: false
  }, options || {});

  this.checkLoggingOption();
};
Utils.inherit(Query, AbstractQuery);

Query.prototype.getInsertIdField = function() {
  return 'lastID';
};

/**
 * rewrite query with parameters
 */
Query.formatBindParameters = function(sql, values, dialect) {
  var bindParam = [];
  if (Array.isArray(values)) {
    bindParam = {};
    values.forEach(function(v, i) {
      bindParam['$'+(i+1)] = v;
    });
    sql = AbstractQuery.formatBindParameters(sql, values, dialect, { skipValueReplace: true })[0];
  } else {
    bindParam = {};
    if (typeof values === 'object') {
      Object.keys(values).forEach(function(k) {
        bindParam['$'+k] = values[k];
      });
    }
    sql = AbstractQuery.formatBindParameters(sql, values, dialect, { skipValueReplace: true })[0];
  }
  return [sql, bindParam];
};

Query.prototype.$collectModels = function(include, prefix) {
  var ret = {};

  if (include) {
    include.forEach(function (include) {
      var key;
      if (!prefix) {
        key = include.as;
      } else {
        key = prefix + '.' + include.as;
      }
      ret[key] = include.model;

      if (include.include) {
        _.merge(ret, this.$collectModels(include.include, key));
      }
    }, this);
  }

  return ret;
};

Query.prototype.run = function(sql, parameters) {
  var self = this
    , promise;

  this.sql = AbstractQuery.formatBindParameters(sql, self.options.bind, self.options.dialect, { skipUnescape: true })[0];
  // var method = self.getDatabaseMethod();
  // if (method === 'exec') {
  //   // exec does not support bind parameter
  //   sql = AbstractQuery.formatBindParameters(sql, self.options.bind, self.options.dialect, { skipUnescape: true })[0];
  //   this.sql = sql;
  // }

  //do we need benchmark for this query execution
  var benchmark = this.sequelize.options.benchmark || this.options.benchmark;

  if (benchmark) {
    var queryBegin = Date.now();
  } else {
    this.sequelize.log('Executing: ' + this.sql, this.options);
  }

  promise = new Promise(function(resolve) {
    var columnTypes = {};
    self.database.transaction(function(db) {
      var executeSql = function() {
        if (self.sql.indexOf('-- ') === 0) {
          return resolve();
        } else {
          resolve(new Promise(function(resolve, reject) {

            var errorCallback = function(transaction, error) {
              if (benchmark) {
                self.sequelize.log('Executed: ' + self.sql, (Date.now() - queryBegin), self.options);
              }
              error.sql = self.sql;
              reject(self.formatError(error));
            }

            var successCallback = function(transaction, results) {

              if (benchmark) {
                self.sequelize.log('Executed: ' + self.sql, (Date.now() - queryBegin), self.options);
              }

              var metaData = this
                , result = self.instance;

              results = self.convertToArray(results);
              // add the inserted row id to the instance
              if (self.isInsertQuery(results, metaData)) {
                self.handleInsertQuery(results, metaData);

                if (!self.instance) {
                  result = metaData[self.getInsertIdField()];
                }
              }

              if (self.sql.indexOf('sqlite_master') !== -1) {
                result = results.map(function(resultSet) { return resultSet.name; });
              } else if (self.isSelectQuery()) {
                if (!self.options.raw) {
                  // This is a map of prefix strings to models, e.g. user.projects -> Project model
                  var prefixes = self.$collectModels(self.options.include);

                  results = results.map(function(result) {
                    return _.mapValues(result, function (value, name) {
                      var model;
                      if (name.indexOf('.') !== -1) {
                        var lastind = name.lastIndexOf('.');

                        model = prefixes[name.substr(0, lastind)];

                        name = name.substr(lastind + 1);
                      } else {
                        model = self.options.model;
                      }

                      var tableName = model.getTableName().toString().replace(/`/g, '')
                        , tableTypes = columnTypes[tableName] || {};

                      if (tableTypes && !(name in tableTypes)) {
                        // The column is aliased
                         _.forOwn(model.rawAttributes, function (attribute, key) {
                          if (name === key && attribute.field) {
                            name = attribute.field;
                            return false;
                          }
                        });
                      }

                      var type = tableTypes[name];
                      if (type) {
                        if (type.indexOf('(') !== -1) {
                          // Remove the lenght part
                          type = type.substr(0, type.indexOf('('));
                        }
                        type = type.replace('UNSIGNED', '').replace('ZEROFILL', '');
                        type = type.trim().toUpperCase();
                        var parse = parserStore.get(type);

                        if (value !== null && parse) {
                          return parse(value, { timezone: self.sequelize.options.timezone});
                        }
                      }
                      return value;
                    });
                  });
                }

                result = self.handleSelectQuery(results);
              } else if (self.isShowOrDescribeQuery()) {
                result = results;
              } else if (self.sql.indexOf('PRAGMA INDEX_LIST') !== -1) {
                result = self.handleShowIndexesQuery(results);
              } else if (self.sql.indexOf('PRAGMA INDEX_INFO') !== -1) {
                result = results;
              } else if (self.sql.indexOf('PRAGMA TABLE_INFO') !== -1) {
                // this is the sqlite way of getting the metadata of a table
                result = {};

                var defaultValue;
                results.forEach(function(_result) {
                  if (_result.dflt_value === null) {
                    // Column schema omits any "DEFAULT ..."
                    defaultValue = undefined;
                  } else if (_result.dflt_value === 'NULL') {
                    // Column schema is a "DEFAULT NULL"
                    defaultValue = null;
                  } else {
                    defaultValue = _result.dflt_value;
                  }

                  result[_result.name] = {
                    type: _result.type,
                    allowNull: (_result.notnull === 0),
                    defaultValue: defaultValue,
                    primaryKey : (_result.pk === 1)
                  };

                  if (result[_result.name].type === 'TINYINT(1)') {
                    result[_result.name].defaultValue = { '0': false, '1': true }[result[_result.name].defaultValue];
                  }

                  if (typeof result[_result.name].defaultValue === 'string') {
                    result[_result.name].defaultValue = result[_result.name].defaultValue.replace(/'/g, '');
                  }
                });
              } else if (self.sql.indexOf('PRAGMA foreign_keys;') !== -1) {
                result = results[0];
              } else if (self.sql.indexOf('PRAGMA foreign_keys') !== -1) {
                result = results;
              } else if (self.sql.indexOf('PRAGMA foreign_key_list') !== -1) {
                result = results;
              } else if ([QueryTypes.BULKUPDATE, QueryTypes.BULKDELETE].indexOf(self.options.type) !== -1) {
                result = metaData.changes;
              } else if (self.options.type === QueryTypes.UPSERT) {
                result = undefined;
              } else if (self.options.type === QueryTypes.VERSION) {
                result = results[0].version;
              } else if (self.options.type === QueryTypes.RAW) {
                result = [results, metaData];
              }

              resolve(result);
            };

            db.executeSql(self.sql, parameters || [], successCallback, errorCallback);
            // if (method === 'exec') {
            //   // exec does not support bind parameter
            //   self.database[method](self.sql, afterExecute);
            // } else {
            //   if (!parameters) parameters = [];
            // }
          }));
          return null;
        }
      };


      return executeSql();
    });
  });

  return promise;
};

Query.prototype.formatError = function (err) {
  var match;

  switch (err.code) {
    case 'SQLITE_CONSTRAINT':
      match = err.message.match(/FOREIGN KEY constraint failed/);
      if (match !== null) {
        return new sequelizeErrors.ForeignKeyConstraintError({
          parent :err
        });
      }

      var fields = [];
      console.log("formatting error");
      // Sqlite pre 2.2 behavior - Error: SQLITE_CONSTRAINT: columns x, y are not unique
      match = err.message.match(/columns (.*?) are/);
      if (match !== null && match.length >= 2) {
        fields = match[1].split(', ');
      } else {

        // Sqlite post 2.2 behavior - Error: SQLITE_CONSTRAINT: UNIQUE constraint failed: table.x, table.y
        match = err.message.match(/UNIQUE constraint failed: (.*)/);
        if (match !== null && match.length >= 2) {
          fields = match[1].split(', ').map(function (columnWithTable) {
            return columnWithTable.split('.')[1];
          });
        }
      }

      var errors = []
        , self = this
        , message = 'Validation error';

      fields.forEach(function(field) {
        errors.push(new sequelizeErrors.ValidationErrorItem(
          self.getUniqueConstraintErrorMessage(field),
          'unique violation', field, self.instance && self.instance[field]));
      });

      if (this.model) {
        _.forOwn(this.model.uniqueKeys, function(constraint) {
          if (_.isEqual(constraint.fields, fields) && !!constraint.msg) {
            message = constraint.msg;
            return false;
          }
        });
      }

      return new sequelizeErrors.UniqueConstraintError({
        message: message,
        errors: errors,
        parent: err,
        fields: fields
      });

    case 'SQLITE_BUSY':
      return new sequelizeErrors.TimeoutError(err);

    default:
      return new sequelizeErrors.DatabaseError(err);
  }
};

Query.prototype.handleShowIndexesQuery = function (results) {
  var self = this;
  // Sqlite returns indexes so the one that was defined last is returned first. Lets reverse that!

  return this.sequelize.Promise.map(results.reverse(), function (item) {
    item.fields = [];
    item.primary = false;
    item.unique = !!item.unique;

    return self.run('PRAGMA INDEX_INFO(`' + item.name + '`)').then(function (columns) {
      columns.forEach(function (column) {
        item.fields[column.seqno] = {
          attribute: column.name,
          length: undefined,
          order: undefined,
        };
      });

      return item;
    });
  });
};

Query.prototype.convertToArray = function(results) {
  var data = [];
  for ( var i = 0; i < results.rows.length; i++) {
    data.push(results.rows.item(i));
  }
  return data;
};

module.exports = Query;
