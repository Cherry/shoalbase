<?php
// Dumps phpMyAdmin 5.2.3's user preference and page settings forms as JSON, as FormDisplay sees them with English strings.
// Run inside the oracle container: docker exec -i dbadmin-pma php < scripts/extract-config-forms.php > src/lib/pma/config-forms.json

declare(strict_types=1);

define('ROOT_PATH', '/var/www/html/');
define('PHPMYADMIN', true);
require ROOT_PATH . 'libraries/constants.php';
require AUTOLOAD_FILE;

use PhpMyAdmin\Config\ConfigFile;
use PhpMyAdmin\Config\Descriptions;
use PhpMyAdmin\Config\Form;
use PhpMyAdmin\Config\FormDisplay;
use PhpMyAdmin\Config\Forms\Page\PageFormList;
use PhpMyAdmin\Config\Forms\User\UserFormList;
use PhpMyAdmin\Config\Validator;
use PhpMyAdmin\Core;
use PhpMyAdmin\LanguageManager;
use PhpMyAdmin\UserPreferences;

$GLOBALS['server'] = 1;
$GLOBALS['containerBuilder'] = Core::getContainerBuilder();
$GLOBALS['config'] = $GLOBALS['containerBuilder']->get('config');
$GLOBALS['cfg'] = $GLOBALS['config']->settings;
$GLOBALS['cfg']['Server'] = $GLOBALS['cfg']['Servers'][1];
$GLOBALS['dbi'] = null;
$_SESSION = [];
LanguageManager::getInstance()->getLanguage('en')->activate();

function privateCall(object $object, string $method, array $args)
{
    $reflection = new ReflectionMethod(FormDisplay::class, $method);
    $reflection->setAccessible(true);

    return $reflection->invokeArgs($object, $args);
}

function privateGet(object $object, string $property)
{
    $reflection = new ReflectionProperty(FormDisplay::class, $property);
    $reflection->setAccessible(true);

    return $reflection->getValue($object);
}

/** One FormDisplay group, field by field, without values that depend on the request. */
$fieldInfo = [];

/** One FormDisplay group; field details go to $fieldInfo once, as page forms reuse the user forms' fields. */
function dumpFormClass(string $class): array
{
    global $fieldInfo;

    $cf = new ConfigFile($GLOBALS['config']->baseSettings);
    (new UserPreferences())->pageInit($cf);
    Form::resetGroupCounter();
    $formDisplay = new $class($cf);
    $validators = Validator::getValidators($cf);
    $forms = [];
    foreach (privateGet($formDisplay, 'forms') as $form) {
        $fields = [];
        foreach ($form->fields as $field => $path) {
            $type = $form->getOptionType($field);
            if ($type === 'group') {
                if (mb_substr((string) $field, 7, 4) === 'end:') {
                    $fields[] = ['group' => 'end'];
                } else {
                    $fields[] = ['group' => 'header', 'text' => mb_substr((string) $field, 7)];
                }

                continue;
            }

            $opts = [];
            $inputType = [
                'string' => 'text',
                'short_string' => 'short_text',
                'double' => 'number_text',
                'integer' => 'number_text',
                'boolean' => 'checkbox',
                'select' => 'select',
                'array' => 'list',
            ][$type];
            if ($inputType === 'select') {
                $opts['values'] = $form->getOptionValueList($form->fields[$field]);
            }

            privateCall($formDisplay, 'setComments', [$path, &$opts]);
            $entry = [
                'type' => $inputType,
                'name' => Descriptions::get($path),
                'desc' => Descriptions::get($path, 'desc'),
                'cmt' => Descriptions::get($path, 'cmt'),
                'doc' => $formDisplay->getDocLink($path),
                'default' => $cf->getDefault($path),
            ];
            if (isset($opts['values'])) {
                // Pairs keep the option order and key types, which a JSON object would lose for numeric keys.
                $entry['values'] = [];
                foreach ($opts['values'] as $key => $label) {
                    $entry['values'][] = [$key, $label];
                }
            }

            if (isset($validators[$path])) {
                $entry['validators'] = array_map(static fn ($validator) => (array) $validator, (array) $validators[$path]);
            }

            $fieldInfo[$path] = $entry;
            if (isset($form->default[$path])) {
                $fields[] = ['path' => $path, 'setvalue' => (string) $form->default[$path]];
            } else {
                $fields[] = $path;
            }
        }

        $forms[] = [
            'name' => $form->name,
            'title' => Descriptions::get('Form_' . $form->name),
            'desc' => Descriptions::get('Form_' . $form->name, 'desc'),
            'fields' => $fields,
        ];
    }

    return $forms;
}

$pageList = new ReflectionProperty(PageFormList::class, 'all');
$pageList->setAccessible(true);
$userList = new ReflectionProperty(UserFormList::class, 'all');
$userList->setAccessible(true);

$result = ['page' => [], 'user' => [], 'userFields' => UserFormList::getFields(), 'fields' => []];
foreach ($pageList->getValue() as $name) {
    $result['page'][$name] = dumpFormClass(PageFormList::get($name));
}

foreach ($userList->getValue() as $name) {
    $result['user'][$name] = dumpFormClass(UserFormList::get($name));
}

$result['fields'] = $fieldInfo;
echo json_encode($result, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "
";
