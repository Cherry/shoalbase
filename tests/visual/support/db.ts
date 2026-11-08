import mysql from 'mysql2/promise';

/** Scratch objects all start with this prefix so cleanup never touches players or other agents' tables. */
export const PREFIX = 'vis_';

export async function withDb<T>(work: (connection: mysql.Connection) => Promise<T>): Promise<T> {
	const connection = await mysql.createConnection({
		host: process.env.PMA_VISUAL_DB_HOST ?? '127.0.0.1',
		port: Number(process.env.PMA_VISUAL_DB_PORT ?? 33306),
		user: process.env.PMA_ORACLE_USER ?? 'customer',
		password: process.env.PMA_ORACLE_PASSWORD ?? 'customerpw',
		database: 'customer_db',
	});
	try {
		return await work(connection);
	} finally {
		await connection.end();
	}
}

/** A 30 row table so browse screens show pagination with the default 25 rows per page. */
export async function createPagesTable(connection: mysql.Connection, name: string): Promise<void> {
	await connection.query(`DROP TABLE IF EXISTS \`${name}\``);
	await connection.query(`CREATE TABLE \`${name}\` (id INT NOT NULL PRIMARY KEY, label VARCHAR(32) NOT NULL, amount INT NOT NULL) ENGINE=InnoDB`);
	const rows = Array.from({ length: 30 }, (_, index) => [index + 1, `row ${String(index + 1).padStart(2, '0')}`, (index * 7) % 30]);
	await connection.query(`INSERT INTO \`${name}\` (id, label, amount) VALUES ?`, [rows]);
	// MaxExactCount=0 makes phpMyAdmin trust InnoDB's row estimate, which stays stale until the table is analyzed.
	await connection.query(`ANALYZE TABLE \`${name}\``);
}

export async function dropScratchTables(connection: mysql.Connection): Promise<void> {
	const [rows] = await connection.query('SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE ?', [`${PREFIX.replace('_', String.raw`\_`)}%`]);
	for (const row of rows as { name: string; }[]) {
		await connection.query(`DROP TABLE IF EXISTS \`${row.name}\``);
	}
}
