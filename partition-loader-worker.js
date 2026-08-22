/* Worker boundary for partition downloads and BGRC composition. */
'use strict';

importScripts('multi-state-routing.js', 'partition-runtime.js');

const controller = new PartitionRouting.PartitionLoaderController({
  postMessage: (message, transfer) => postMessage(message, transfer || []),
});

onmessage = (event) => { controller.handle(event.data); };
