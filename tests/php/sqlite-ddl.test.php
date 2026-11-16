<?php
// Tests the SQLite table rebuild in patches/shared/lib/ddl/sqlite_sql_generator.php.
//
// SQLite cannot alter most of a table in place, so the generator copies the table
// out, drops it, creates it again and copies the rows back. Every test here runs
// on a table that already has rows, because an empty table hides the bugs.
//
// Usage: php tests/php/sqlite-ddl.test.php <moodle-source-dir>
// The source must already be patched (scripts/patch-moodle-source.sh). Needs the
// pdo_sqlite extension. No Moodle install is needed.

define('CLI_SCRIPT', true);
define('ABORT_AFTER_CONFIG', true);
define('CACHE_DISABLE_ALL', true);

if (empty($argv[1]) || !is_file($argv[1] . '/lib/setup.php')) {
    fwrite(STDERR, "Usage: php tests/php/sqlite-ddl.test.php <moodle-source-dir>\n");
    exit(2);
}

$workdir = sys_get_temp_dir() . '/sqlite-ddl-test-' . getmypid();
mkdir($workdir . '/data', 0777, true);

global $CFG, $DB;
$CFG = new stdClass();
$CFG->dbtype = 'sqlite3';
$CFG->dblibrary = 'pdo';
$CFG->prefix = 't_';
$CFG->dboptions = ['file' => $workdir . '/test.sq3.php'];
$CFG->wwwroot = 'http://localhost';
$CFG->dataroot = $workdir . '/data';
$CFG->directorypermissions = 0777;
require($argv[1] . '/lib/setup.php');
require_once($CFG->libdir . '/setuplib.php');
require_once($CFG->libdir . '/moodlelib.php');
require_once($CFG->libdir . '/filelib.php');
require_once($CFG->libdir . '/dmllib.php');
require_once($CFG->libdir . '/ddllib.php');

// Moodle's handlers print a page and hide the error, so report failures directly.
set_exception_handler(null);
restore_error_handler();

$DB = moodle_database::get_driver_instance('sqlite3', 'pdo');
$DB->connect('', '', '', '', $CFG->prefix, $CFG->dboptions);
$dbman = $DB->get_manager();

$failures = 0;

/**
 * Creates t_demo with three rows and the indexes a real plugin table has.
 */
function make_demo_table(): void {
    global $DB;
    $dbman = $DB->get_manager();
    $table = new xmldb_table('demo');
    if ($dbman->table_exists($table)) {
        $dbman->drop_table($table);
    }
    $table->add_field('id', XMLDB_TYPE_INTEGER, '10', null, XMLDB_NOTNULL, XMLDB_SEQUENCE);
    $table->add_field('courseid', XMLDB_TYPE_INTEGER, '10', null, XMLDB_NOTNULL, null, '0');
    $table->add_field('name', XMLDB_TYPE_CHAR, '100', null, XMLDB_NOTNULL, null, '');
    $table->add_field('code', XMLDB_TYPE_CHAR, '20', null, null, null, null);
    $table->add_field('notes', XMLDB_TYPE_TEXT, null, null, null, null, null);
    $table->add_key('primary', XMLDB_KEY_PRIMARY, ['id']);
    $table->add_key('courseid', XMLDB_KEY_FOREIGN, ['courseid'], 'course', ['id']);
    $table->add_index('name', XMLDB_INDEX_NOTUNIQUE, ['name']);
    $table->add_index('code', XMLDB_INDEX_UNIQUE, ['code']);
    $dbman->create_table($table);
    foreach ([[5, 'alpha', 'A1'], [5, 'beta', 'B2'], [9, 'gamma', null]] as [$courseid, $name, $code]) {
        $DB->insert_record('demo', ['courseid' => $courseid, 'name' => $name, 'code' => $code, 'notes' => "$name notes"]);
    }
}

/**
 * The table's indexes as sorted "unique:col,col" strings, ignoring names.
 */
function index_shapes(): array {
    global $DB;
    $shapes = [];
    foreach ($DB->get_indexes('demo') as $name => $index) {
        if (strpos($name, 'sqlite_autoindex') === 0) {
            continue;
        }
        $shapes[] = ($index['unique'] ? 'unique:' : 'index:') . implode(',', $index['columns']);
    }
    sort($shapes);
    return $shapes;
}

/**
 * Rows as "id|courseid|name|code|notes" strings, in id order.
 */
function row_strings(array $extrafields = []): array {
    global $DB;
    $fields = array_merge(['id', 'courseid', 'name', 'code', 'notes'], $extrafields);
    $rows = [];
    foreach ($DB->get_records('demo', null, 'id', implode(',', $fields)) as $record) {
        $rows[] = implode('|', array_map(fn($field) => $record->$field ?? 'NULL', $fields));
    }
    return $rows;
}

const DEMO_INDEXES = ['index:courseid', 'index:name', 'unique:code'];
const DEMO_ROWS = ['1|5|alpha|A1|alpha notes', '2|5|beta|B2|beta notes', '3|9|gamma|NULL|gamma notes'];

function check(string $name, callable $test): void {
    global $failures;
    try {
        make_demo_table();
        $problems = $test();
    } catch (Throwable $e) {
        $problems = [get_class($e) . ': ' . $e->getMessage() . (isset($e->debuginfo) ? ' ' . $e->debuginfo : '')];
    }
    if ($problems) {
        $failures++;
        echo "not ok - $name\n";
        foreach ($problems as $problem) {
            echo "    $problem\n";
        }
    } else {
        echo "ok - $name\n";
    }
}

/**
 * Compares a value with what it should be, returning a problem line or nothing.
 */
function expect(string $what, $actual, $expected): array {
    if ($actual === $expected) {
        return [];
    }
    return ["$what: expected " . json_encode($expected) . ', got ' . json_encode($actual)];
}

check('add_field NOT NULL with a default fills existing rows with the default', function() use ($dbman) {
    $dbman->add_field(new xmldb_table('demo'),
        new xmldb_field('grade', XMLDB_TYPE_INTEGER, '10', null, XMLDB_NOTNULL, null, '7'));
    $dbman->add_field(new xmldb_table('demo'),
        new xmldb_field('status', XMLDB_TYPE_CHAR, '10', null, XMLDB_NOTNULL, null, 'new'));
    return array_merge(
        expect('rows', row_strings(['grade', 'status']),
            array_map(fn($row) => "$row|7|new", DEMO_ROWS)),
        expect('indexes', index_shapes(), DEMO_INDEXES),
    );
});

check('add_field nullable with no default leaves existing rows NULL', function() use ($dbman) {
    $dbman->add_field(new xmldb_table('demo'),
        new xmldb_field('feedback', XMLDB_TYPE_TEXT, null, null, null, null, null));
    return array_merge(
        expect('rows', row_strings(['feedback']), array_map(fn($row) => "$row|NULL", DEMO_ROWS)),
        expect('indexes', index_shapes(), DEMO_INDEXES),
    );
});

check('the rebuilt id column keeps counting from the old rows', function() use ($dbman, $DB) {
    $dbman->add_field(new xmldb_table('demo'),
        new xmldb_field('grade', XMLDB_TYPE_INTEGER, '10', null, XMLDB_NOTNULL, null, '0'));
    $newid = $DB->insert_record('demo', ['courseid' => 1, 'name' => 'delta']);
    return expect('new id', (int)$newid, 4);
});

check('a unique index still refuses duplicates after a rebuild', function() use ($dbman, $DB) {
    $dbman->add_field(new xmldb_table('demo'),
        new xmldb_field('grade', XMLDB_TYPE_INTEGER, '10', null, XMLDB_NOTNULL, null, '0'));
    try {
        $DB->insert_record('demo', ['courseid' => 1, 'name' => 'copy', 'code' => 'A1']);
    } catch (dml_write_exception $e) {
        return [];
    }
    return ['a second row with code A1 was accepted'];
});

check('rename_field moves the data and the index to the new name', function() use ($dbman) {
    $dbman->rename_field(new xmldb_table('demo'),
        new xmldb_field('name', XMLDB_TYPE_CHAR, '100', null, XMLDB_NOTNULL, null, ''), 'title');
    return array_merge(
        expect('titles', array_values(array_map(fn($r) => $r->title,
            $GLOBALS['DB']->get_records('demo', null, 'id', 'id,title'))), ['alpha', 'beta', 'gamma']),
        expect('indexes', index_shapes(), ['index:courseid', 'index:title', 'unique:code']),
    );
});

check('drop_field keeps the other columns and indexes', function() use ($dbman) {
    $dbman->drop_field(new xmldb_table('demo'), new xmldb_field('notes'));
    return array_merge(
        expect('columns', array_keys($GLOBALS['DB']->get_columns('demo', false)),
            ['id', 'courseid', 'name', 'code']),
        expect('names', array_values(array_map(fn($r) => $r->name,
            $GLOBALS['DB']->get_records('demo', null, 'id', 'id,name'))), ['alpha', 'beta', 'gamma']),
        expect('indexes', index_shapes(), DEMO_INDEXES),
    );
});

check('change_field_precision keeps the rows and indexes', function() use ($dbman) {
    $dbman->change_field_precision(new xmldb_table('demo'),
        new xmldb_field('notes', XMLDB_TYPE_CHAR, '255', null, null, null, null));
    return array_merge(
        expect('rows', row_strings(), DEMO_ROWS),
        expect('indexes', index_shapes(), DEMO_INDEXES),
    );
});

check('change_field_default keeps the rows and indexes', function() use ($dbman) {
    $dbman->change_field_default(new xmldb_table('demo'),
        new xmldb_field('notes', XMLDB_TYPE_TEXT, null, null, null, null, null));
    $dbman->add_field(new xmldb_table('demo'),
        new xmldb_field('grade', XMLDB_TYPE_INTEGER, '10', null, XMLDB_NOTNULL, null, '0'));
    $dbman->change_field_default(new xmldb_table('demo'),
        new xmldb_field('grade', XMLDB_TYPE_INTEGER, '10', null, XMLDB_NOTNULL, null, '5'));
    return array_merge(
        expect('rows', row_strings(['grade']), array_map(fn($row) => "$row|0", DEMO_ROWS)),
        expect('indexes', index_shapes(), DEMO_INDEXES),
    );
});

check('add_index adds one index and keeps the others', function() use ($dbman) {
    $dbman->add_index(new xmldb_table('demo'), new xmldb_index('coursename', XMLDB_INDEX_NOTUNIQUE, ['courseid', 'name']));
    return array_merge(
        expect('rows', row_strings(), DEMO_ROWS),
        expect('indexes', index_shapes(), ['index:courseid', 'index:courseid,name', 'index:name', 'unique:code']),
    );
});

check('drop_index drops that index only', function() use ($dbman) {
    $dbman->drop_index(new xmldb_table('demo'), new xmldb_index('name', XMLDB_INDEX_NOTUNIQUE, ['name']));
    return array_merge(
        expect('rows', row_strings(), DEMO_ROWS),
        expect('indexes', index_shapes(), ['index:courseid', 'unique:code']),
    );
});

check('add_key adds its index and keeps the others', function() use ($dbman) {
    $dbman->add_key(new xmldb_table('demo'),
        new xmldb_key('coursename', XMLDB_KEY_FOREIGN, ['courseid', 'name'], 'other', ['courseid', 'name']));
    $dbman->add_key(new xmldb_table('demo'), new xmldb_key('codecourse', XMLDB_KEY_UNIQUE, ['code', 'courseid']));
    return array_merge(
        expect('rows', row_strings(), DEMO_ROWS),
        expect('indexes', index_shapes(),
            ['index:courseid', 'index:courseid,name', 'index:name', 'unique:code', 'unique:code,courseid']),
    );
});

check('drop_key drops its index only', function() use ($dbman) {
    $dbman->drop_key(new xmldb_table('demo'), new xmldb_key('courseid', XMLDB_KEY_FOREIGN, ['courseid'], 'course', ['id']));
    return array_merge(
        expect('rows', row_strings(), DEMO_ROWS),
        expect('indexes', index_shapes(), ['index:name', 'unique:code']),
    );
});

check('an index the caller describes is not added twice', function() use ($dbman) {
    $table = new xmldb_table('demo');
    $table->add_index('name', XMLDB_INDEX_NOTUNIQUE, ['name']);
    $dbman->add_field($table, new xmldb_field('grade', XMLDB_TYPE_INTEGER, '10', null, XMLDB_NOTNULL, null, '0'));
    return expect('indexes', index_shapes(), DEMO_INDEXES);
});

check('a composite primary key gets no extra index', function() use ($dbman, $DB) {
    $table = new xmldb_table('pair');
    if ($dbman->table_exists($table)) {
        $dbman->drop_table($table);
    }
    $table->add_field('userid', XMLDB_TYPE_INTEGER, '10', null, XMLDB_NOTNULL, null, '0');
    $table->add_field('itemid', XMLDB_TYPE_INTEGER, '10', null, XMLDB_NOTNULL, null, '0');
    $table->add_key('primary', XMLDB_KEY_PRIMARY, ['userid', 'itemid']);
    $dbman->create_table($table);
    $DB->execute('INSERT INTO {pair} (userid, itemid) VALUES (1, 2), (1, 3)');
    $dbman->add_field(new xmldb_table('pair'),
        new xmldb_field('grade', XMLDB_TYPE_INTEGER, '10', null, XMLDB_NOTNULL, null, '4'));
    $ours = array_filter(array_keys($DB->get_indexes('pair')), fn($name) => strpos($name, 'sqlite_autoindex') !== 0);
    $problems = array_merge(
        expect('indexes we made', array_values($ours), []),
        expect('rows', $DB->get_fieldset_sql("SELECT userid || '|' || itemid || '|' || grade FROM {pair} ORDER BY itemid"),
            ['1|2|4', '1|3|4']),
    );
    try {
        $DB->execute('INSERT INTO {pair} (userid, itemid) VALUES (1, 2)');
        $problems[] = 'the primary key accepted a duplicate';
    } catch (dml_write_exception $e) {
        // The primary key still holds.
    }
    $dbman->drop_table(new xmldb_table('pair'));
    return $problems;
});

$DB->dispose();
remove_dir($workdir);
echo $failures ? "$failures failed\n" : "all passed\n";
exit($failures ? 1 : 0);
