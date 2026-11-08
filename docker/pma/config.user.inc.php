<?php
// The configuration this port reproduces: cookie login, no configuration storage, server details hidden.
// 1 = MySQL 8.4, 2 = MariaDB 12.3 over TLS, 3 = MySQL 5.7. The image generates blowfish_secret itself.
$cfg['Servers'] = [];
$i = 0;
foreach ([['dbadmin-mysql', false], ['dbadmin-mariadb', true], ['dbadmin-mysql57', false]] as [$host, $ssl]) {
    $i++;
    $cfg['Servers'][$i]['auth_type'] = 'cookie';
    $cfg['Servers'][$i]['host'] = $host;
    $cfg['Servers'][$i]['connect_type'] = 'tcp';
    $cfg['Servers'][$i]['compress'] = false;
    $cfg['Servers'][$i]['AllowNoPassword'] = false;
    if ($ssl) {
        $cfg['Servers'][$i]['ssl'] = true;
    }
}
$cfg['DisplayServersList'] = false;
$cfg['ShowServerInfo'] = false;
$cfg['MaxExactCount'] = 0;
$cfg['MaxExactCountViews'] = 0;
$cfg['UploadDir'] = '';
$cfg['SaveDir'] = '';
