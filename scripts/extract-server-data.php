<?php
// Dumps the English strings and rule tables of phpMyAdmin 5.2.3's server pages: status variable descriptions, advisor rules and storage engine details.
// Run inside the oracle container: docker exec -i dbadmin-pma php < scripts/extract-server-data.php > src/lib/pma/server/server-data.json

declare(strict_types=1);

define('ROOT_PATH', '/var/www/html/');
define('PHPMYADMIN', true);
require ROOT_PATH . 'libraries/constants.php';
require AUTOLOAD_FILE;

use PhpMyAdmin\Controllers\Server\Status\VariablesController;
use PhpMyAdmin\Core;
use PhpMyAdmin\LanguageManager;
use PhpMyAdmin\StorageEngine;

$GLOBALS['containerBuilder'] = Core::getContainerBuilder();
$GLOBALS['config'] = $GLOBALS['containerBuilder']->get('config');
$GLOBALS['cfg'] = $GLOBALS['config']->settings;
LanguageManager::getInstance()->getLanguage('en')->activate();

function privateCall(string $class, object $object, string $method, array $args = [])
{
    $reflection = new ReflectionMethod($class, $method);
    $reflection->setAccessible(true);

    return $reflection->invokeArgs($object, $args);
}

$statusController = (new ReflectionClass(VariablesController::class))->newInstanceWithoutConstructor();
$statusDescriptions = privateCall(VariablesController::class, $statusController, 'getDescriptions');

$advisorGeneric = include ROOT_PATH . 'libraries/advisory_rules_generic.php';
$advisorBefore80003 = include ROOT_PATH . 'libraries/advisory_rules_mysql_before80003.php';

$engines = [];
foreach (glob(ROOT_PATH . 'libraries/classes/Engines/*.php') as $file) {
    $class = 'PhpMyAdmin\\Engines\\' . basename($file, '.php');
    $engine = (new ReflectionClass($class))->newInstanceWithoutConstructor();
    $engine->engine = '{engine}';
    // Info pages are only offered for supported engines.
    $engine->support = 2;
    $engines[strtolower(basename($file, '.php'))] = [
        'variables' => (object) $engine->getVariables(),
        'like' => $engine->getVariablesLikePattern(),
        'infoPages' => (object) $engine->getInfoPages(),
        'helpPage' => $engine->getMysqlHelpPage(),
    ];
}

echo json_encode([
    'statusDescriptions' => $statusDescriptions,
    'advisorRules' => ['generic' => $advisorGeneric, 'before80003' => $advisorBefore80003],
    'engines' => $engines,
], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT) . "\n";
