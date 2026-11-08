<?php
// Dumps Transformations::getAvailableMimeTypes() with each plugin's name and description, in English.
// Run inside the oracle container: docker exec -i dbadmin-pma php < scripts/extract-transformations.php > src/lib/pma/transformations.json

declare(strict_types=1);

define('ROOT_PATH', '/var/www/html/');
define('PHPMYADMIN', true);
require ROOT_PATH . 'libraries/constants.php';
require AUTOLOAD_FILE;

use PhpMyAdmin\Core;
use PhpMyAdmin\LanguageManager;
use PhpMyAdmin\Transformations;

$GLOBALS['containerBuilder'] = Core::getContainerBuilder();
$GLOBALS['config'] = $GLOBALS['containerBuilder']->get('config');
$GLOBALS['cfg'] = $GLOBALS['config']->settings;
LanguageManager::getInstance()->getLanguage('en')->activate();

$transformations = new Transformations();
$stack = $transformations->getAvailableMimeTypes();
$plugins = [];
foreach (['transformation_file', 'input_transformation_file'] as $key) {
    foreach ($stack[$key] ?? [] as $file) {
        $plugins[$file] = ['name' => $transformations->getName($file), 'description' => $transformations->getDescription($file)];
    }
}

echo json_encode(['mimeTypes' => $stack, 'plugins' => $plugins], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n";
