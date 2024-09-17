const { EventEmitter } = require('events');
const mapValues = require('lodash/mapValues');
const initSqlJs = require('sql.js/dist/sql-wasm');

// `sqlite3`'s `Database` interface:
// https://github.com/TryGhost/node-sqlite3/blob/master/lib/sqlite3.d.ts
//
// Extends `EventEmitter` to mimick `sqlite3`'s `Database` behavior.
// Only emits a few events:
// * "open"
// * "close"
// * "error"
// Doesn't emit events:
// * "trace"
// * "profile"
// * "change"
//
class Database extends EventEmitter {
	// `filename: string` is a path to the file in which the data will be stored. Example: ":memory:".
	// `mode?: number` is an optional access mode: read-only, read-write, etc.
	// `callback?: function` gets called after the database is ready, or if there was an error.
	constructor(bytes, mode, callback) {
		super();
    const cb = typeof mode === 'function' ? mode : callback;

		const onError = (error) => {
			if (cb) {
				cb(error);
			} else {
				// "If no `callback` is provided and an error occurred,
				// an `error` event with the error object as the only parameter
				// will be emitted".
				this.emit('error', error);
			}
		};

		const onSuccess = () => {
			// "If opening succeeded, an `open` event with no parameters is emitted,
			//  regardless of whether a `callback` was provided or not".
			this.emit('open');
			// Call the `callback`.
			if (cb) {
				cb(null);
			}
		};

    // "You can omit `locateFile` when running in Node.js".
    //
    // When `locateFile` parameter is not omitted in Node.js, it throws an error:
    // "Error: ENOENT: no such file or directory, open 'https:\sql.js.org\dist\sql-wasm.wasm'".
    //
    // May be somehow related: https://github.com/sql-js/sql.js/issues/528
		initSqlJs().then((SQL) => {
      // Create a database.
      this.database = new SQL.Database(bytes || Uint8Array.from([]));
      onSuccess();
    }, onError);
	}

	// "Closes the database.
	//  `callback` (optional): If provided, this function will be called when the database
	//  was closed successfully or when an error occurred. The first argument is an `error` object.
	//  When it is null, closing succeeded. If no `callback` is provided and an error occurred,
	//  an "error" event with the `error` object as the only parameter will be emitted on the database object.
	//  If closing succeeded, a "close" event with no parameters is emitted, regardless of whether
	//  a `callback` was provided or not.
	close(callback) {
		this.database.close();
		this.emit('close');
		if (callback) {
			callback(null);
		}
	}

	// "Set a configuration option for the database. Valid options are:
	//  * Tracing & profiling
	//    * trace: provide a function callback as a value. Invoked when an SQL statement executes, with a rendering of the statement text.
	//    * profile: provide a function callback. Invoked every time an SQL statement executes.
	//  * busyTimeout: provide an integer as a value. Sets the busy timeout".
	configure() {}

	// "Loads a compiled SQLite extension into the database connection object".
	loadExtension() {
		throw new Error('`loadExtension()` is not supported');
	}

	// "Allows the user to interrupt long-running queries.
	//  Wrapper around `sqlite3_interrupt` and causes other data-fetching functions
	//  to be passed an `error` with `code = sqlite3.INTERRUPT`".
	interrupt() {
		// This method is not implemented because `sql.js` methods are "synchronous" ("blocking").

		// this.database.exec('select interrupt();')
	}

	// There're no docs on this method.
	// I guess it calls the `callback` after all queries have finished.
	wait(callback) {
		// `sql.js` methods are "synchronous" ("blocking")
		// so the `wait()` method doesn't really make sense here.
		// It just calls the `callback`.
		if (callback) {
			callback(null);
		}
	}

	// https://stackoverflow.com/questions/41949724/how-does-db-serialize-work-in-node-sqlite3
	// "Each command inside the `serialize()`'s `func` function is guaranteed to finish executing
	//  before the next one starts".
	serialize(func) {
		func();
	}

	// https://www.sqlitetutorial.net/sqlite-nodejs/statements-control-flow/
	// "The `serialize()` method allows you to execute statements in serialized mode,
	//  while the `parallelize()` method executes the statements in parallel".
	parallelize(func) {
		func();
	}

	// "Runs the SQL query with the specified parameters and calls the `callback` afterwards.
	//  It does not retrieve any result data".
	run(...args) {
		const {
			query,
			callback: unboundCallback,
			parameters
		} = getRunArguments(args);

    // console.log('>>>>run', query);

		// "The context of the `callback` function (the `this` object inside the function)
		//  is the statement object".
		//
		// "If execution was successful, the this object will contain two properties named
		//  `lastID` and `changes` which contain the value of the last inserted row ID
		//  and the number of rows affected by this query respectively".
		//
		const statement = {};

		let callback = unboundCallback;
		if (callback) {
			callback = callback.bind(statement);
		}

		try {
      const db = this.database;
			// Run the query.
			db.run(query, parameters);

			// Just a simple "lame" SQL operation type detection.
			const isInsert = /^\s*insert\s+/i.test(query);
			const isUpdate = /^\s*update\s+/i.test(query);
			const isDelete = /^\s*delete\s+/i.test(query);

			// Gets a value from the database.
			const getValue = (query) => {
				const results = db.exec(`${query  };`);
				return results[0].values[0][0];
			};

			if (isInsert) {
				// The row ID of the most recent successful INSERT.
				statement.lastID = getValue('select last_insert_rowid()');
			}

			if (isInsert || isUpdate || isDelete) {
				// The number of rows modified, inserted or deleted by the most recently completed
				// INSERT, UPDATE or DELETE statement.
				statement.changes = getValue('select changes()');
			}

			if (callback) {
				callCallbackAsynchronously(callback, null);
			}
		} catch (error) {
			if (callback) {
				callCallbackAsynchronously(callback, error);
			} else {
				// "When no `callback` is provided and an error occurs,
				//  an "error" event will be emitted".
				this.emit('error', error);
				// throw error
			}
		}

		// Returns `this` for method chaining.
		return this;
	}

	// "Runs the SQL query with the specified parameters and calls the `callback`
	//  with all result rows afterwards".
	all(...args) {
		const {
			query,
			callback,
			parameters
		} = getRunArguments(args);
    // console.log('>>>>all', query, parameters);

		try {
      const db = this.database;
			const results = [];

			db.each(query, parameters,
				// When a query has produced a result (only for `SELECT` queries).
				(result) => {
					results.push(result);
				},
				// When all queries have finished.
				() => {
					if (callback) {
						callCallbackAsynchronously(callback, null, results);
					}
				}
			);
		} catch (error) {
			if (callback) {
				callCallbackAsynchronously(callback, error);
			} else {
				throw error;
			}
		}

		// Returns `this` for method chaining.
		return this;
	}

	// "Runs the SQL query with the specified parameters and calls the `callback`
	//  once for each result row".
	each(...args) {
		const {
			query,
			callback,
			parameters
		} = getRunArguments(args);
    // console.log('>>>>each', query);

		try {
      const db = this.database;
			db.each(query, parameters,
				// When a query has produced a result (only for `SELECT` queries).
				(result) => {
					if (callback) {
						callCallbackAsynchronously(callback, null, result);
					}
				}
			);
		} catch (error) {
			if (callback) {
				callCallbackAsynchronously(callback, error);
			} else {
				throw error;
			}
		}

		// Returns `this` for method chaining.
		return this;
	}

	get(...args) {
		const {
			query,
			callback,
			parameters
		} = getRunArguments(args);
    // console.log('>>>>get', query);

		try {
      const db = this.database;
			const results = db.exec(query, parameters);

			// "If the result set is empty, the second parameter is `undefined`,
			//  otherwise it is an object containing the values for the first row.
			//  The property `names` correspond to the column names of the result set".
			//
			// I dunno if the `result` object is correct or not.
			// It's more of a "placeholder" implementation.
			//
			const result = results[0];

			if (callback) {
				callCallbackAsynchronously(callback, null, result);
			}
		} catch (error) {
			if (callback) {
				callCallbackAsynchronously(callback, error);
			} else {
				throw error;
			}
		}

		// Returns `this` for method chaining.
		return this;
	}

	// "Runs all SQL queries in the supplied string. No result rows are retrieved".
	exec(query, callback) {
    // console.log('>>>>exec', query);
		try {
      const db = this.database;
			db.exec(query);

			if (callback) {
				callCallbackAsynchronously(callback, null);
			}
		} catch (error) {
			if (callback) {
				callCallbackAsynchronously(callback, error);
			} else {
				// "When no `callback` is provided and an error occurs,
				//  an "error" event will be emitted".
				this.emit('error', error);
				// throw error
			}
		}

		// Returns `this` for method chaining.
		return this;
	}

	// "Prepares the SQL statement and optionally binds the specified parameters
	//  and calls the callback when done. The function returns a Statement object."
	prepare(...args) {
		const {
			query,
			callback,
			parameters
		} = getRunArguments(args);
    // console.log('>>>>prepare', query);

		let statement = {};

		try {
      const db = this.database;
			statement = db.prepare(query, parameters);

			if (callback) {
				callCallbackAsynchronously(callback, null);
			}
		} catch (error) {
			if (callback) {
				callCallbackAsynchronously(callback, error);
			} else {
				throw error;
			}
		}

		return statement;
	}
}

function callCallbackAsynchronously(callback, error, result) {
	process.nextTick(() => callback(error, result));
}

function getRunArguments(args) {
	const query = args.shift();
	let parameters;
	let callback;

  // Sort out the arguments.
	if (args.length === 0) {
		parameters = [];
	} else {
		if (typeof args[args.length - 1] === 'function') {
			callback = args.pop();
		}
		parameters = args;
	}

	// If parameters were passed as an object then convert them to an object.
	if (parameters.length === 1) {
		if (parameters[0] !== null && typeof parameters[0] === 'object') {
			parameters = parameters[0];
		}
	}

  const paramPrepare = (item) => (item instanceof Date) ? item.toISOString() : item;

	return {
		query,
		parameters: Array.isArray(parameters) ? parameters.map(paramPrepare) : mapValues(parameters, paramPrepare),
		callback
	};
}

exports.Database = Database;
