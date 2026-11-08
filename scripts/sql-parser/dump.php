<?php
// The PHP half of the sql-parser differential test: mirrors src/sql-parser/__tests__/differential.ts section by section.
// Usage (inside the phpMyAdmin container): php dump.php <autoload.php> <cases.json> [locale]; prints one JSON object per line.
declare(strict_types=1);

use PhpMyAdmin\MoTranslator\Loader;
use PhpMyAdmin\SqlParser\Context;
use PhpMyAdmin\SqlParser\Token;
use PhpMyAdmin\SqlParser\TokensList;
use PhpMyAdmin\SqlParser\Utils\Tokens;
use PhpMyAdmin\SqlParser\Exceptions\LexerException;
use PhpMyAdmin\SqlParser\Exceptions\ParserException;
use PhpMyAdmin\SqlParser\Lexer;
use PhpMyAdmin\SqlParser\Parser;
use PhpMyAdmin\SqlParser\Statements\CreateStatement;
use PhpMyAdmin\SqlParser\Translator;
use PhpMyAdmin\SqlParser\UtfString;
use PhpMyAdmin\SqlParser\Utils\BufferedQuery;
use PhpMyAdmin\SqlParser\Utils\Error as ParserError;
use PhpMyAdmin\SqlParser\Utils\Formatter;
use PhpMyAdmin\SqlParser\Utils\Misc;
use PhpMyAdmin\SqlParser\Utils\Query;
use PhpMyAdmin\SqlParser\Utils\Routine;
use PhpMyAdmin\SqlParser\Utils\Table;

error_reporting(E_ALL & ~E_WARNING & ~E_NOTICE & ~E_DEPRECATED);
ini_set('display_errors', 'stderr');
ini_set('memory_limit', '2G');

require $argv[1];
$cases = json_decode((string) file_get_contents($argv[2]), true);
Translator::setLocale($argv[3] ?? 'en');

const SKIPPED = ['KEYWORD_NAME_INDICATORS', 'OPERATOR_NAME_INDICATORS'];
const CLAUSES = ['SELECT', 'FROM', 'WHERE', 'GROUP BY', 'HAVING', 'ORDER BY', 'LIMIT', 'SET', 'VALUES', 'INTO'];
const FORMATS = [
    ['type' => 'text'],
    ['type' => 'html'],
    ['type' => 'cli'],
    ['type' => 'html', 'remove_comments' => true, 'parts_newline' => false],
    ['type' => 'text', 'clause_newline' => false, 'indentation' => "\t", 'line_ending' => "\r\n"],
];

/** The canonical form of dump.ts. */
function d($value)
{
    if ($value === null || is_bool($value) || is_int($value) || is_float($value) || is_string($value)) {
        return $value;
    }
    if (is_array($value)) {
        if (array_is_list($value)) {
            return array_map('d', $value);
        }
        $pairs = [];
        foreach ($value as $key => $item) {
            $pairs[] = [(string) $key, d($item)];
        }
        return ['@a' => $pairs];
    }
    if ($value instanceof UtfString) {
        return $value->str;
    }
    if ($value instanceof LexerException) {
        return ['@c' => 'LexerException', 'message' => $value->getMessage(), 'code' => $value->getCode(), 'ch' => $value->ch, 'pos' => $value->pos];
    }
    if ($value instanceof ParserException) {
        return ['@c' => 'ParserException', 'message' => $value->getMessage(), 'code' => $value->getCode(), 'token' => d($value->token)];
    }
    if (is_object($value)) {
        $class = get_class($value);
        $result = ['@c' => substr($class, (int) strrpos($class, '\\') + 1)];
        foreach (get_object_vars($value) as $key => $item) {
            if (in_array($key, SKIPPED, true)) {
                continue;
            }
            $result[$key] = d($item);
        }
        return $result;
    }
    return (string) $value;
}

function attempt(callable $run)
{
    try {
        return d($run());
    } catch (Throwable $e) {
        return ['@throw' => true];
    }
}

/** BufferedQuery::extract() keeps its position in a static variable, which every case must start from 0. */
function resetBufferedQuery(): void
{
    $statics = (new ReflectionMethod(BufferedQuery::class, 'extract'))->getStaticVariables();
    $position = $statics['i'] ?? 0;
    if ($position !== 0) {
        $bq = new BufferedQuery(str_repeat(' ', $position) . ';');
        $bq->extract(true);
    }
}

function buffered(string $query): array
{
    $runs = [];
    foreach ([[], ['parse_delimiter' => true, 'add_delimiter' => true]] as $options) {
        resetBufferedQuery();
        $bq = new BufferedQuery($query, $options);
        $statements = [];
        $guard = 0;
        while (($statement = $bq->extract(true)) !== false && $guard++ < 1000) {
            $statements[] = $statement;
        }
        $runs[] = $statements;
    }

    resetBufferedQuery();
    $bq = new BufferedQuery();
    $statements = [];
    $length = mb_strlen($query);
    for ($offset = 0; $offset < $length; $offset += 37) {
        $bq->query .= mb_substr($query, $offset, 37);
        $guard = 0;
        while (($statement = $bq->extract()) !== false && $statement !== '' && $guard++ < 1000) {
            $statements[] = $statement;
        }
    }
    $guard = 0;
    while (($statement = $bq->extract(true)) !== false && $guard++ < 1000) {
        $statements[] = $statement;
    }
    $runs[] = $statements;
    resetBufferedQuery();

    return $runs;
}

function strictErrors(string $input): array
{
    $results = [];
    foreach ([static fn () => new Lexer($input, true), static fn () => new Parser($input, true)] as $build) {
        try {
            $build();
            $results[] = 'ok';
        } catch (LexerException | ParserException $e) {
            $results[] = $e;
        }
    }
    return $results;
}

function tokensListScenario(string $input): array
{
    $list = Lexer::getTokens($input);
    $results = [$list[0] === null ? null : $list[0]->token, isset($list[-1]), isset($list[$list->count])];
    $list[] = new Token('X');
    $list[1] = new Token('Y');
    unset($list[0]);
    unset($list[$list->count + 5]);
    $results[] = $list->count;
    $results[] = TokensList::build($list);
    $list->idx = $list->count - 1;
    $previous = $list->getPrevious();
    $results[] = $previous === null ? null : $previous->token;
    $previous = $list->getPreviousOfType([Token::TYPE_KEYWORD, Token::TYPE_NONE]);
    $results[] = $previous === null ? null : $previous->token;
    $list->idx = 0;
    $next = $list->getNextOfType(Token::TYPE_SYMBOL);
    $results[] = $next === null ? null : $next->token;
    $results[] = TokensList::build('raw');
    $results[] = TokensList::build(array_slice($list->tokens, 0, 3));
    return $results;
}

function apiScenario(string $name, string $input)
{
    $formats = [
        ['type' => Token::TYPE_KEYWORD, 'flags' => Token::FLAG_KEYWORD_RESERVED, 'html' => 'class="r"', 'function' => 'strtolower'],
        ['type' => Token::TYPE_NUMBER, 'html' => 'class="n"'],
        ['type' => Token::TYPE_OPERATOR, 'flags' => 0, 'html' => 'class="o"', 'function' => 'strtoupper'],
    ];
    switch ($name) {
        case 'loadClosest':
            return [Context::loadClosest($input), Context::$loadedContext];
        case 'setMode':
            Context::setMode($input);
            return [Context::getMode(), Context::hasMode(2), Context::hasMode(1073741824), Context::hasMode(), Context::getIdentifierQuote()];
        case 'replaceTokens':
            $find = [['type' => Token::TYPE_KEYWORD, 'value' => 'SELECT'], ['value_str' => 'distinct']];
            $replace = [new Token('SELECT DISTINCTROW', Token::TYPE_KEYWORD)];
            $list = Tokens::replaceTokens(Lexer::getTokens($input), [['type' => Token::TYPE_OPERATOR, 'flags' => Token::FLAG_OPERATOR_SQL]], []);
            return [Tokens::replaceTokens($input, $find, $replace), TokensList::build($list), Tokens::match(new Token('x'), ['token' => 'x', 'flags' => 1])];
        case 'strict':
            return strictErrors($input);
        case 'formats':
            return [Formatter::format($input, ['type' => 'html', 'formats' => $formats]), Formatter::format($input, ['type' => 'text', 'formats' => $formats])];
        case 'listLocales':
            return Loader::listLocales($input);
        case 'tokensList':
            return tokensListScenario($input);
    }
    throw new RuntimeException('Unknown scenario ' . $name);
}

function querySections(string $query): array
{
    $sections = [];

    $lexer = new Lexer($query);
    $parser = new Parser($lexer->list);
    $sections['lexer'] = d($lexer);
    $sections['parser'] = d($parser);
    $sections['errors'] = attempt(static function () use ($lexer, $parser) {
        $errors = ParserError::get([$lexer, $parser]);
        return [$errors, ParserError::format($errors)];
    });

    $statements = $parser->statements;
    $first = $statements[0] ?? null;

    $sections['build'] = array_map(static fn ($statement) => attempt(static fn () => $statement->build()), $statements);
    $sections['flags'] = array_map(static fn ($statement) => attempt(static fn () => Query::getFlags($statement, true)), $statements);
    $sections['getAll'] = attempt(static function () use ($query) {
        $all = Query::getAll($query);
        unset($all['parser'], $all['statement']);
        return $all;
    });

    if ($first !== null) {
        $clauses = [];
        foreach (CLAUSES as $clause) {
            foreach ([0, -1, 1] as $type) {
                $clauses[] = attempt(static fn () => Query::getClause($first, $parser->list, $clause, $type));
            }
        }
        $sections['clauses'] = $clauses;
        $sections['replace'] = [
            attempt(static fn () => Query::replaceClause($first, $parser->list, 'ORDER BY `x` DESC')),
            attempt(static fn () => Query::replaceClause($first, $parser->list, 'WHERE', 'WHERE 1 = 1', true)),
            attempt(static fn () => Query::replaceClauses($first, $parser->list, [['WHERE', 'WHERE 1'], ['ORDER BY', 'ORDER BY 2'], ['LIMIT', 'LIMIT 1']])),
        ];
        $sections['aliases'] = attempt(static fn () => Misc::getAliases($first, 'db'));

        if ($first instanceof CreateStatement) {
            $sections['table'] = attempt(static fn () => [Table::getFields($first), Table::getForeignKeys($first)]);
            $sections['routine'] = attempt(static fn () => Routine::getParameters($first));
        }
    }

    $sections['tables'] = array_map(static fn ($statement) => attempt(static fn () => Query::getTables($statement)), $statements);

    $sections['first'] = [attempt(static fn () => Query::getFirstStatement($query)), attempt(static fn () => Query::getFirstStatement($query, '$$'))];
    // The CLI color of the previous token is a static; formatting a plain word first makes it the same for every case.
    Formatter::format('x', ['type' => 'cli']);
    $sections['format'] = array_map(static fn ($options) => attempt(static fn () => Formatter::format($query, $options)), FORMATS);
    $sections['buffered'] = attempt(static fn () => buffered($query));

    return $sections;
}

foreach ($cases as $case) {
    // Some queries make the parser loop forever; the runner treats the resulting fatal error as a hang.
    set_time_limit(20);
    Context::load($case['context'] ?? '');
    Context::setMode($case['mode'] ?? 0);
    switch ($case['kind'] ?? 'query') {
        case 'returnType':
            $sections = ['result' => attempt(static fn () => Routine::getReturnType($case['query']))];
            break;
        case 'parameter':
            $sections = ['result' => attempt(static fn () => Routine::getParameter($case['query']))];
            break;
        case 'api':
            $sections = ['result' => attempt(static fn () => apiScenario($case['api'] ?? '', $case['query']))];
            break;
        case 'escape':
            $sections = ['result' => attempt(static fn () => [Context::escape($case['query']), Context::escape($case['query'], '"'), Context::isKeyword($case['query']), Context::isKeyword($case['query'], true)])];
            break;
        default:
            $sections = querySections($case['query']);
    }
    Context::setMode(0);
    Context::load('');
    echo json_encode(['id' => $case['id'], 'sections' => $sections], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE | JSON_PARTIAL_OUTPUT_ON_ERROR), "\n";
}
