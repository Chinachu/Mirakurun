# How To Multiplexing Mirakuruns

At first, This project has called "Mirakurun**s**".
The goal is to make able to unify multiple Mirakurun servers and simply.

## Limitations

* At this time, multiple regions isn't supported for one channel type.
  You can use something like VPN but keep carefully don't mix different region in one channel type. (especially GR.)

## General Patterns

### a) Extends

* Mirakurun A
  * Tuners
* Mirakurun B (Extended)
  * Tuners

```
                              +-------------+
                    Tuners -> |             |
           +-------------+    | Mirakurun A | -> (client)
 Tuners -> | Mirakurun B | -> |             |
           +-------------+    +-------------+
```

### b) Unify

* Mirakurun A
  * CAS Processor
  * No Tuners
* Mirakurun B (192.168.1.102)
  * Tuners
* Mirakurun C (192.168.1.103)
  * Tuners
* Mirakurun D (192.168.1.104)
  * Tuners

```
           +-------------+    +-------------+
 Tuners -> | Mirakurun B | -> |             |
           +-------------+    |             |
           +-------------+    |             |
 Tuners -> | Mirakurun C | -> | Mirakurun A | -> (client)
           +-------------+    |             |
           +-------------+    |             |
 Tuners -> | Mirakurun D | -> |             |
           +-------------+    +-------------+
                                     |
                              [CAS Processor]
```


#### Example Configuration

##### tuners.yml (Mirakurun A)

```yaml
- name: Mirakurun-B-T1
  types:
    - GR
  remoteMirakurunHost: 192.168.1.102
  remoteMirakurunDecoder: false
  decoder: CAS-PROCESSOR-CMD

- name: Mirakurun-B-T2
  types:
    - GR
  remoteMirakurunHost: 192.168.1.102
  remoteMirakurunDecoder: false
  decoder: CAS-PROCESSOR-CMD

- name: Mirakurun-B-S1
  types:
    - BS
    - CS
  remoteMirakurunHost: 192.168.1.102
  remoteMirakurunDecoder: false
  decoder: CAS-PROCESSOR-CMD

- name: Mirakurun-B-S2
  types:
    - BS
    - CS
  remoteMirakurunHost: 192.168.1.102
  remoteMirakurunDecoder: false
  decoder: CAS-PROCESSOR-CMD

- name: Mirakurun-C-T
  types:
    - GR
  remoteMirakurunHost: 192.168.1.103
  remoteMirakurunDecoder: false
  decoder: CAS-PROCESSOR-CMD

- name: Mirakurun-C-S
  types:
    - BS
    - CS
  remoteMirakurunHost: 192.168.1.103
  remoteMirakurunDecoder: false
  decoder: CAS-PROCESSOR-CMD

- name: Mirakurun-D-SKY
  types:
    - SKY
  remoteMirakurunHost: 192.168.1.104
  remoteMirakurunDecoder: false
  decoder: CAS-PROCESSOR-CMD
```

##### other configs

Set up as usual.
